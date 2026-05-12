package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

type config struct {
	Port            string
	InternalSecret  string
	SiteDomain      string
	TraefikNetwork  string
	LocalBindIP     string
	LocalPublicHost string
	RedisURL        string
	HarnessImage    string
}

func loadConfig() config {
	get := func(k, fallback string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return fallback
	}
	cfg := config{
		Port:            get("PORT", "8080"),
		InternalSecret:  os.Getenv("INTERNAL_API_SECRET"),
		SiteDomain:      get("SITE_DOMAIN", "orqestra.xyz"),
		TraefikNetwork:  get("TRAEFIK_NETWORK", "proxy"),
		LocalBindIP:     os.Getenv("LOCAL_BIND_IP"),
		LocalPublicHost: os.Getenv("LOCAL_PUBLIC_HOST"),
		RedisURL:        get("REDIS_URL", "redis://redis:6379"),
		HarnessImage:    get("HARNESS_IMAGE", "orqestra-agenthive-runtime:latest"),
	}
	if cfg.InternalSecret == "" {
		log.Fatal("INTERNAL_API_SECRET required")
	}
	return cfg
}

func internalAuth(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		got := c.GetHeader("X-Internal-Secret")
		if subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}

// ---- Server ----

type server struct {
	cfg    config
	docker *client.Client
	rdb    *redis.Client

	tailsMu sync.Mutex
	tails   map[string]context.CancelFunc
}

func (s *server) startTail(swarmID, containerID string) {
	s.tailsMu.Lock()
	defer s.tailsMu.Unlock()
	if cancel, ok := s.tails[swarmID]; ok {
		cancel()
	}
	s.tails[swarmID] = startLogTail(s.docker, s.cfg.RedisURL, swarmID, containerID)
}

func (s *server) stopTail(swarmID string) {
	s.tailsMu.Lock()
	defer s.tailsMu.Unlock()
	if cancel, ok := s.tails[swarmID]; ok {
		cancel()
		delete(s.tails, swarmID)
	}
}

// buildHarnessImage builds the Python harness image from the embedded
// Dockerfile + main.py if it isn't already present.
func (s *server) buildHarnessImage(ctx context.Context) error {
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, s.cfg.HarnessImage); err == nil {
		return nil
	}
	files := map[string]string{
		"Dockerfile":       harnessDockerfile,
		"main.py":          harnessPython,
		"requirements.txt": harnessRequirements,
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, content := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o644,
			Size: int64(len(content)),
		}); err != nil {
			return err
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	resp, err := s.docker.ImageBuild(ctx, &buf, types.ImageBuildOptions{
		Tags:        []string{s.cfg.HarnessImage},
		Remove:      true,
		ForceRemove: true,
		PullParent:  true,
		Dockerfile:  "Dockerfile",
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	dec := json.NewDecoder(resp.Body)
	for {
		var msg struct {
			Stream string `json:"stream"`
			Error  string `json:"error"`
		}
		if err := dec.Decode(&msg); err != nil {
			if err == io.EOF {
				break
			}
			return err
		}
		if msg.Error != "" {
			return fmt.Errorf("docker build: %s", msg.Error)
		}
	}
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, s.cfg.HarnessImage); err != nil {
		return fmt.Errorf("image %s missing after build: %w", s.cfg.HarnessImage, err)
	}
	return nil
}

// uploadSpec writes /etc/orqestra/swarm.json into the container so the harness
// reads its spec from disk at start. Separate from env so the spec can be
// arbitrarily large.
func (s *server) uploadSpec(ctx context.Context, containerID, specJSON string) error {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{
		Name:     "orqestra/",
		Mode:     0o755,
		Typeflag: tar.TypeDir,
	}); err != nil {
		return err
	}
	content := []byte(specJSON)
	if err := tw.WriteHeader(&tar.Header{
		Name: "orqestra/swarm.json",
		Mode: 0o644,
		Size: int64(len(content)),
	}); err != nil {
		return err
	}
	if _, err := tw.Write(content); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return s.docker.CopyToContainer(ctx, containerID, "/etc", &buf, container.CopyToContainerOptions{})
}

// ---- Request/response types ----

type createReq struct {
	SwarmID      string `json:"swarmId" binding:"required"`
	Slug         string `json:"slug" binding:"required"`
	UserID       string `json:"userId" binding:"required"`
	SpecJSON     string `json:"specJson" binding:"required"`
	OpenAIAPIKey string `json:"openaiApiKey"`
	CPULimit     string `json:"cpuLimit"`
	MemoryLimit  string `json:"memoryLimit"`
}

type createResp struct {
	ContainerID   string `json:"containerId"`
	ContainerPort int    `json:"containerPort"`
}

type runReq struct {
	ContainerID     string `json:"containerId" binding:"required"`
	RunID           string `json:"runId" binding:"required"`
	ThreadID        string `json:"threadId" binding:"required"`
	SwarmID         string `json:"swarmId" binding:"required"`
	UserMessage     string `json:"userMessage" binding:"required"`
	APICallbackBase string `json:"apiCallbackBase" binding:"required"`
	InternalSecret  string `json:"internalSecret" binding:"required"`
}

type startReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type stopReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type destroyReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type statsReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type statsResp struct {
	ContainerID      string  `json:"containerId"`
	Name             string  `json:"name"`
	ReadAt           string  `json:"readAt"`
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryUsageBytes uint64  `json:"memoryUsageBytes"`
	MemoryLimitBytes uint64  `json:"memoryLimitBytes"`
	MemoryPercent    float64 `json:"memoryPercent"`
	Pids             uint64  `json:"pids"`
}

// ---- Handlers ----

func (s *server) handleCreate(c *gin.Context) {
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()

	if err := s.buildHarnessImage(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "build image: " + err.Error()})
		return
	}

	labels := map[string]string{
		"orqestra.kind":     "swarm",
		"orqestra.swarm_id": req.SwarmID,
		"orqestra.user_id":  req.UserID,
	}

	bindIP := s.cfg.LocalBindIP
	if bindIP == "" {
		bindIP = "127.0.0.1"
	}

	hostConfig := &container.HostConfig{
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		PortBindings: nat.PortMap{
			nat.Port("7000/tcp"): []nat.PortBinding{{HostIP: bindIP, HostPort: ""}},
		},
	}
	if req.CPULimit != "" {
		hostConfig.NanoCPUs = parseCPU(req.CPULimit)
	}
	if req.MemoryLimit != "" {
		hostConfig.Memory = parseMemory(req.MemoryLimit)
	}

	envVars := []string{"PYTHONUNBUFFERED=1"}
	if req.OpenAIAPIKey != "" {
		envVars = append(envVars, "OPENAI_API_KEY="+req.OpenAIAPIKey)
	}

	exposed := nat.PortSet{nat.Port("7000/tcp"): struct{}{}}

	// Attach to traefik network so the orchestrator can reach the container
	// by name during /run. SiteDomain=localhost mode still works because
	// orchestrator-agenthive runs on the host net via compose if user prefers,
	// but the default compose deployment runs everything on the `proxy` net.
	var netCfg *network.NetworkingConfig
	if s.cfg.TraefikNetwork != "" && s.cfg.SiteDomain != "localhost" {
		netCfg = &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				s.cfg.TraefikNetwork: {},
			},
		}
	}

	resp, err := s.docker.ContainerCreate(
		ctx,
		&container.Config{
			Image:        s.cfg.HarnessImage,
			Env:          envVars,
			Labels:       labels,
			ExposedPorts: exposed,
		},
		hostConfig,
		netCfg,
		nil,
		"orqestra-agenthive-"+req.Slug,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create: " + err.Error()})
		return
	}

	if err := s.uploadSpec(ctx, resp.ID, req.SpecJSON); err != nil {
		_ = s.docker.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload spec: " + err.Error()})
		return
	}

	if err := s.docker.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = s.docker.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "start: " + err.Error()})
		return
	}
	s.startTail(req.SwarmID, resp.ID)

	hostPort, err := s.lookupHostPort(ctx, resp.ID)
	if err != nil {
		log.Printf("lookup port: %v", err)
	}

	c.JSON(http.StatusOK, createResp{
		ContainerID:   resp.ID,
		ContainerPort: hostPort,
	})
}

func (s *server) lookupHostPort(ctx context.Context, containerID string) (int, error) {
	insp, err := s.docker.ContainerInspect(ctx, containerID)
	if err != nil {
		return 0, err
	}
	if bindings, ok := insp.NetworkSettings.Ports["7000/tcp"]; ok && len(bindings) > 0 {
		if p := bindings[0].HostPort; p != "" {
			n, _ := strconv.Atoi(p)
			return n, nil
		}
	}
	return 0, fmt.Errorf("no host port bound")
}

// dialHarness returns the URL the orchestrator uses to reach a swarm's
// harness FastAPI. Compose mode → use container internal name + 7000.
// Localhost mode → use 127.0.0.1 + mapped host port.
func (s *server) dialHarness(ctx context.Context, containerID string) (string, error) {
	insp, err := s.docker.ContainerInspect(ctx, containerID)
	if err != nil {
		return "", err
	}
	if s.cfg.TraefikNetwork != "" {
		if nets := insp.NetworkSettings.Networks; nets != nil {
			if ep, ok := nets[s.cfg.TraefikNetwork]; ok && ep.IPAddress != "" {
				return fmt.Sprintf("http://%s:7000", ep.IPAddress), nil
			}
		}
	}
	if bindings, ok := insp.NetworkSettings.Ports["7000/tcp"]; ok && len(bindings) > 0 {
		p := bindings[0].HostPort
		host := bindings[0].HostIP
		if host == "" || host == "0.0.0.0" {
			host = "127.0.0.1"
		}
		return fmt.Sprintf("http://%s:%s", host, p), nil
	}
	return "", fmt.Errorf("cannot dial harness for %s", containerID)
}

func (s *server) handleRun(c *gin.Context) {
	var req runReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()
	base, err := s.dialHarness(ctx, req.ContainerID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "dial: " + err.Error()})
		return
	}

	// Wait briefly for harness to be up — fresh containers need ~1-3 s.
	if !waitForReady(ctx, base+"/health", 30*time.Second) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "harness not ready"})
		return
	}

	payload, _ := json.Marshal(map[string]any{
		"runId":           req.RunID,
		"threadId":        req.ThreadID,
		"swarmId":         req.SwarmID,
		"userMessage":     req.UserMessage,
		"apiCallbackBase": req.APICallbackBase,
		"internalSecret":  req.InternalSecret,
	})

	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/run", bytes.NewReader(payload))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Accept", "text/event-stream")

	clientHTTP := &http.Client{Timeout: 30 * time.Minute}
	resp, err := clientHTTP.Do(hreq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "harness: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		c.JSON(resp.StatusCode, gin.H{"error": string(body)})
		return
	}

	// Drain SSE-ish stream from harness and publish each `data:` line to Redis
	// channel `container-logs:<runId>` so the WS service fans out to clients.
	channel := "container-logs:" + req.RunID
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimPrefix(line, "data: ")
		trimmed = strings.TrimPrefix(trimmed, "data:")
		if trimmed == "" || trimmed == line && !strings.HasPrefix(line, "{") {
			// Ignore SSE control lines, blank separators.
			continue
		}
		_ = s.rdb.Publish(ctx, channel, trimmed).Err()
	}
	if err := scanner.Err(); err != nil {
		log.Printf("harness stream err: %v", err)
		_ = s.rdb.Publish(ctx, channel, `{"type":"error","message":"`+err.Error()+`"}`).Err()
	}
	_ = s.rdb.Publish(ctx, channel, "__RUN_COMPLETE__").Err()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func waitForReady(ctx context.Context, url string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return true
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
	return false
}

func (s *server) handleStart(c *gin.Context) {
	var req startReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()
	if err := s.docker.ContainerStart(ctx, req.ContainerID, container.StartOptions{}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "start: " + err.Error()})
		return
	}
	if insp, ierr := s.docker.ContainerInspect(ctx, req.ContainerID); ierr == nil {
		if sid := insp.Config.Labels["orqestra.swarm_id"]; sid != "" {
			s.startTail(sid, req.ContainerID)
		}
	}
	hp, _ := s.lookupHostPort(ctx, req.ContainerID)
	c.JSON(http.StatusOK, gin.H{"containerPort": hp})
}

func (s *server) handleStop(c *gin.Context) {
	var req stopReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()
	if insp, ierr := s.docker.ContainerInspect(ctx, req.ContainerID); ierr == nil {
		if sid := insp.Config.Labels["orqestra.swarm_id"]; sid != "" {
			s.stopTail(sid)
		}
	}
	if err := s.docker.ContainerStop(ctx, req.ContainerID, container.StopOptions{}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) handleDestroy(c *gin.Context) {
	var req destroyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()
	if insp, ierr := s.docker.ContainerInspect(ctx, req.ContainerID); ierr == nil {
		if sid := insp.Config.Labels["orqestra.swarm_id"]; sid != "" {
			s.stopTail(sid)
		}
	}
	_ = s.docker.ContainerStop(ctx, req.ContainerID, container.StopOptions{})
	if err := s.docker.ContainerRemove(ctx, req.ContainerID, container.RemoveOptions{
		Force:         true,
		RemoveVolumes: false,
	}); err != nil && !client.IsErrNotFound(err) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "remove: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func calculateCPUPercent(stats container.StatsResponse) float64 {
	cpuStats := stats.CPUStats
	pre := stats.PreCPUStats
	if cpuStats.CPUUsage.TotalUsage <= pre.CPUUsage.TotalUsage ||
		cpuStats.SystemUsage <= pre.SystemUsage {
		return 0
	}
	cpuDelta := float64(cpuStats.CPUUsage.TotalUsage - pre.CPUUsage.TotalUsage)
	sysDelta := float64(cpuStats.SystemUsage - pre.SystemUsage)
	online := float64(cpuStats.OnlineCPUs)
	if online == 0 {
		online = float64(len(cpuStats.CPUUsage.PercpuUsage))
	}
	if online == 0 {
		online = 1
	}
	return (cpuDelta / sysDelta) * online * 100
}

func calculateMemoryUsage(stats container.StatsResponse) uint64 {
	usage := stats.MemoryStats.Usage
	if usage == 0 && stats.MemoryStats.PrivateWorkingSet > 0 {
		return stats.MemoryStats.PrivateWorkingSet
	}
	cache := uint64(0)
	if stats.MemoryStats.Stats != nil {
		if v, ok := stats.MemoryStats.Stats["total_inactive_file"]; ok {
			cache = v
		} else if v, ok := stats.MemoryStats.Stats["inactive_file"]; ok {
			cache = v
		}
	}
	if usage > cache {
		return usage - cache
	}
	return usage
}

func (s *server) handleStats(c *gin.Context) {
	var req statsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	reader, err := s.docker.ContainerStats(c.Request.Context(), req.ContainerID, false)
	if err != nil {
		if client.IsErrNotFound(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "container not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stats: " + err.Error()})
		return
	}
	defer reader.Body.Close()
	var stats container.StatsResponse
	if err := json.NewDecoder(reader.Body).Decode(&stats); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "decode: " + err.Error()})
		return
	}
	memoryUsage := calculateMemoryUsage(stats)
	memoryLimit := stats.MemoryStats.Limit
	pct := 0.0
	if memoryLimit > 0 {
		pct = float64(memoryUsage) / float64(memoryLimit) * 100
	}
	readAt := stats.Read.UTC().Format(time.RFC3339Nano)
	if stats.Read.IsZero() {
		readAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	c.JSON(http.StatusOK, statsResp{
		ContainerID:      stats.ID,
		Name:             strings.TrimPrefix(stats.Name, "/"),
		ReadAt:           readAt,
		CPUPercent:       calculateCPUPercent(stats),
		MemoryUsageBytes: memoryUsage,
		MemoryLimitBytes: memoryLimit,
		MemoryPercent:    pct,
		Pids:             stats.PidsStats.Current,
	})
}

func parseCPU(s string) int64 {
	var f float64
	if _, err := fmt.Sscanf(strings.TrimSpace(s), "%f", &f); err != nil || f <= 0 {
		return 0
	}
	return int64(f * 1_000_000_000)
}

func parseMemory(s string) int64 {
	s = strings.TrimSpace(strings.ToUpper(s))
	mult := int64(1)
	switch {
	case strings.HasSuffix(s, "G"), strings.HasSuffix(s, "GB"):
		mult = 1024 * 1024 * 1024
		s = strings.TrimRight(s, "GB")
	case strings.HasSuffix(s, "M"), strings.HasSuffix(s, "MB"):
		mult = 1024 * 1024
		s = strings.TrimRight(s, "MB")
	case strings.HasSuffix(s, "K"), strings.HasSuffix(s, "KB"):
		mult = 1024
		s = strings.TrimRight(s, "KB")
	}
	var n int64
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil || n <= 0 {
		return 0
	}
	return n * mult
}

func main() {
	cfg := loadConfig()

	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		log.Fatalf("docker client: %v", err)
	}

	rOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("redis url: %v", err)
	}
	rdb := redis.NewClient(rOpts)

	s := &server{
		cfg:    cfg,
		docker: cli,
		rdb:    rdb,
		tails:  map[string]context.CancelFunc{},
	}

	// Pre-build harness image so first create is fast.
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := s.buildHarnessImage(bgCtx); err != nil {
			log.Printf("pre-build harness failed: %v", err)
		} else {
			log.Printf("pre-built %s", cfg.HarnessImage)
		}
	}()

	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	api := r.Group("/internal/agenthive", internalAuth(cfg.InternalSecret))
	api.POST("/create", s.handleCreate)
	api.POST("/start", s.handleStart)
	api.POST("/stop", s.handleStop)
	api.POST("/destroy", s.handleDestroy)
	api.POST("/stats", s.handleStats)
	api.POST("/run", s.handleRun)

	log.Printf("orchestrator-agenthive listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatal(err)
	}
}
