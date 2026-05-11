package main

import (
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
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/gin-gonic/gin"
)

type config struct {
	Port             string
	InternalSecret   string
	SiteDomain       string
	TraefikNetwork   string
	CertResolver     string
	Entrypoint       string
	OllamaImage      string
	LocalBindIP      string
	LocalPublicHost  string
	ReservedRamMB    int64
	OllamaVolumeRoot string
	RedisURL         string
}

func loadConfig() config {
	get := func(k, fallback string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return fallback
	}
	cfg := config{
		Port:             get("PORT", "8080"),
		InternalSecret:   os.Getenv("INTERNAL_API_SECRET"),
		SiteDomain:       get("SITE_DOMAIN", "orqestra.xyz"),
		TraefikNetwork:   get("TRAEFIK_NETWORK", "proxy"),
		CertResolver:     get("CERT_RESOLVER", "letsencrypt"),
		Entrypoint:       get("MODEL_ENTRYPOINT", "websecure"),
		OllamaImage:      get("OLLAMA_IMAGE", "ollama/ollama:latest"),
		LocalBindIP:      os.Getenv("LOCAL_BIND_IP"),
		LocalPublicHost:  os.Getenv("LOCAL_PUBLIC_HOST"),
		OllamaVolumeRoot: get("OLLAMA_VOLUME_PREFIX", "orqestra_model_"),
		RedisURL:         get("REDIS_URL", "redis://redis:6379"),
	}
	if cfg.InternalSecret == "" {
		log.Fatal("INTERNAL_API_SECRET required")
	}
	if v := os.Getenv("RESERVED_RAM_MB"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			cfg.ReservedRamMB = n
		}
	} else {
		cfg.ReservedRamMB = 2048
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

// ----- Capabilities probe -----

type GPU struct {
	Index           int     `json:"index"`
	Name            string  `json:"name"`
	VramTotalGB     float64 `json:"vramTotalGB"`
	VramFreeGB      float64 `json:"vramFreeGB"`
	CommittedVramGB float64 `json:"committedVramGB"`
}

type Capabilities struct {
	TotalRamGB     float64 `json:"totalRamGB"`
	FreeRamGB      float64 `json:"freeRamGB"`
	CPUCores       int     `json:"cpuCores"`
	GPUs           []GPU   `json:"gpus"`
	HasGPU         bool    `json:"hasGPU"`
	OS             string  `json:"os"`
	KernelVersion  string  `json:"kernelVersion"`
	CommittedRamGB float64 `json:"committedRamGB"`
	CommittedCpu   float64 `json:"committedCpu"`
}

func readMeminfo() (totalKB, availableKB int64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseInt(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			totalKB = val
		case "MemAvailable:":
			availableKB = val
		}
	}
	return totalKB, availableKB, s.Err()
}

func detectGPUs() []GPU {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return nil
	}
	cmd := exec.Command(
		"nvidia-smi",
		"--query-gpu=index,name,memory.total,memory.free",
		"--format=csv,noheader,nounits",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var gpus []GPU
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, ",")
		if len(parts) < 4 {
			continue
		}
		idx, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
		name := strings.TrimSpace(parts[1])
		totalMB, _ := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
		freeMB, _ := strconv.ParseFloat(strings.TrimSpace(parts[3]), 64)
		gpus = append(gpus, GPU{
			Index:       idx,
			Name:        name,
			VramTotalGB: totalMB / 1024,
			VramFreeGB:  freeMB / 1024,
		})
	}
	return gpus
}

func kernelVersion() string {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (s *server) committedUsage(ctx context.Context) (ramGB, cpu float64, vramByGpu map[int]float64) {
	vramByGpu = map[int]float64{}
	containers, err := s.docker.ContainerList(ctx, container.ListOptions{
		All:     false,
		Filters: orqestraLabelFilter("model"),
	})
	if err != nil {
		return 0, 0, vramByGpu
	}
	for _, c := range containers {
		insp, err := s.docker.ContainerInspect(ctx, c.ID)
		if err != nil {
			continue
		}
		if insp.HostConfig != nil {
			if insp.HostConfig.Memory > 0 {
				ramGB += float64(insp.HostConfig.Memory) / (1024 * 1024 * 1024)
			}
			if insp.HostConfig.NanoCPUs > 0 {
				cpu += float64(insp.HostConfig.NanoCPUs) / 1_000_000_000
			}
		}
		// Read GPU index + advisory VRAM from labels we set at create time.
		idxLabel := c.Labels["orqestra.gpu_index"]
		vramLabel := c.Labels["orqestra.vram_limit_mb"]
		if idxLabel == "" || vramLabel == "" {
			continue
		}
		idx, err1 := strconv.Atoi(idxLabel)
		vram, err2 := strconv.ParseInt(vramLabel, 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		vramByGpu[idx] += float64(vram) / 1024
	}
	return ramGB, cpu, vramByGpu
}

var (
	dockerNvidiaCacheMu sync.Mutex
	dockerNvidiaCache   *bool
	dockerNvidiaCachedAt time.Time
)

func dockerNvidiaRuntimeAvailable(ctx context.Context) bool {
	dockerNvidiaCacheMu.Lock()
	defer dockerNvidiaCacheMu.Unlock()
	if dockerNvidiaCache != nil && time.Since(dockerNvidiaCachedAt) < 60*time.Second {
		return *dockerNvidiaCache
	}
	cmd := exec.CommandContext(ctx, "docker", "info", "--format", "{{json .Runtimes}}")
	out, err := cmd.CombinedOutput()
	ok := err == nil && strings.Contains(string(out), "nvidia")
	dockerNvidiaCache = &ok
	dockerNvidiaCachedAt = time.Now()
	return ok
}

func (s *server) handleCapabilities(c *gin.Context) {
	totalKB, availKB, err := readMeminfo()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "meminfo: " + err.Error()})
		return
	}
	gpus := detectGPUs()
	if gpus == nil {
		gpus = []GPU{} // serialise as [] not null so JS clients can .reduce/.map directly
	}
	committedRam, committedCpu, vramByGpu := s.committedUsage(c.Request.Context())
	for i, g := range gpus {
		gpus[i].CommittedVramGB = vramByGpu[g.Index]
	}
	// GPU is only usable from containers if the NVIDIA Container Toolkit is
	// configured in dockerd. Detection: `docker info` reports `nvidia` under
	// Runtimes when the toolkit + nvidia-container-runtime are wired up.
	dockerHasNvidia := dockerNvidiaRuntimeAvailable(c.Request.Context())
	hasGPU := len(gpus) > 0 && dockerHasNvidia
	if len(gpus) > 0 && !dockerHasNvidia {
		log.Printf("GPU detected but Docker nvidia runtime missing — install nvidia-container-toolkit")
	}
	cap := Capabilities{
		TotalRamGB:     float64(totalKB) / (1024 * 1024),
		FreeRamGB:      float64(availKB) / (1024 * 1024),
		CPUCores:       runtime.NumCPU(),
		GPUs:           gpus,
		HasGPU:         hasGPU,
		OS:             runtime.GOOS,
		KernelVersion:  kernelVersion(),
		CommittedRamGB: committedRam,
		CommittedCpu:   committedCpu,
	}
	c.JSON(http.StatusOK, cap)
}

// ----- Model project lifecycle -----

type createReq struct {
	ProjectID   string  `json:"projectId" binding:"required"`
	Slug        string  `json:"slug" binding:"required"`
	UserID      string  `json:"userId" binding:"required"`
	Runtime     string  `json:"runtime" binding:"required"`
	RuntimeRef  string  `json:"runtimeRef" binding:"required"`
	RamLimitMB  int64   `json:"ramLimitMB" binding:"required"`
	CPULimit    float64 `json:"cpuLimit"`
	GPUIndex    *int    `json:"gpuIndex"`
	VramLimitMB int64   `json:"vramLimitMB"`
}

type createResp struct {
	ContainerID   string `json:"containerId"`
	ContainerPort int    `json:"containerPort"`
	APIURL        string `json:"apiUrl"`
}

type startReq struct {
	ProjectID   string `json:"projectId"`
	ContainerID string `json:"containerId" binding:"required"`
}

type stopReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type destroyReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type server struct {
	cfg     config
	docker  *client.Client
	tailsMu sync.Mutex
	tails   map[string]context.CancelFunc
}

func (s *server) startTail(projectID, containerID string) {
	s.tailsMu.Lock()
	defer s.tailsMu.Unlock()
	if cancel, ok := s.tails[projectID]; ok {
		cancel()
	}
	s.tails[projectID] = startLogTail(s.docker, s.cfg.RedisURL, projectID, containerID)
}

func (s *server) stopTail(projectID string) {
	s.tailsMu.Lock()
	defer s.tailsMu.Unlock()
	if cancel, ok := s.tails[projectID]; ok {
		cancel()
		delete(s.tails, projectID)
	}
}

func orqestraLabelFilter(kind string) filters.Args {
	f := filters.NewArgs()
	f.Add("label", "orqestra.kind="+kind)
	return f
}

func (s *server) ensureImage(ctx context.Context, ref string) error {
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, ref); err == nil {
		return nil
	}
	rc, err := s.docker.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return err
	}
	defer rc.Close()
	_, err = io.Copy(io.Discard, rc)
	return err
}

func (s *server) execLines(ctx context.Context, containerID string, cmd []string) ([]string, error) {
	exec, err := s.docker.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return nil, err
	}
	hijack, err := s.docker.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{})
	if err != nil {
		return nil, err
	}
	defer hijack.Close()
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, hijack.Reader); err != nil {
		return nil, err
	}
	return strings.Split(buf.String(), "\n"), nil
}

func (s *server) handleCreate(c *gin.Context) {
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Runtime != "ollama" && req.Runtime != "docker-model-runner" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported runtime: " + req.Runtime})
		return
	}
	ctx := c.Request.Context()

	switch req.Runtime {
	case "ollama":
		s.createOllama(ctx, c, req)
	case "docker-model-runner":
		s.createDMR(ctx, c, req)
	}
}

func (s *server) createOllama(ctx context.Context, c *gin.Context, req createReq) {
	if err := s.ensureImage(ctx, s.cfg.OllamaImage); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "image: " + err.Error()})
		return
	}

	volumeName := s.cfg.OllamaVolumeRoot + req.Slug
	containerName := "orqestra-model-" + req.Slug
	internalPort := "11434"

	localMode := s.cfg.SiteDomain == "localhost"

	labels := map[string]string{
		"orqestra.kind":       "model",
		"orqestra.runtime":    "ollama",
		"orqestra.project_id": req.ProjectID,
		"orqestra.user_id":    req.UserID,
	}
	if req.GPUIndex != nil {
		labels["orqestra.gpu_index"] = strconv.Itoa(*req.GPUIndex)
		if req.VramLimitMB > 0 {
			labels["orqestra.vram_limit_mb"] = strconv.FormatInt(req.VramLimitMB, 10)
		}
	}
	if !localMode {
		hostRule := fmt.Sprintf("Host(`%s.%s`)", req.Slug, s.cfg.SiteDomain)
		labels["traefik.enable"] = "true"
		labels[fmt.Sprintf("traefik.http.routers.%s.rule", req.Slug)] = hostRule
		labels[fmt.Sprintf("traefik.http.routers.%s.entrypoints", req.Slug)] = s.cfg.Entrypoint
		labels[fmt.Sprintf("traefik.http.routers.%s.tls", req.Slug)] = "true"
		labels[fmt.Sprintf("traefik.http.routers.%s.tls.certresolver", req.Slug)] = s.cfg.CertResolver
		labels[fmt.Sprintf("traefik.http.services.%s.loadbalancer.server.port", req.Slug)] = internalPort
	}

	hostConfig := &container.HostConfig{
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		Binds:         []string{volumeName + ":/root/.ollama"},
		Resources: container.Resources{
			Memory:   req.RamLimitMB * 1024 * 1024,
			NanoCPUs: int64(req.CPULimit * 1_000_000_000),
		},
	}
	if req.GPUIndex != nil {
		hostConfig.DeviceRequests = []container.DeviceRequest{{
			Driver:       "nvidia",
			Capabilities: [][]string{{"gpu"}},
			DeviceIDs:    []string{strconv.Itoa(*req.GPUIndex)},
		}}
	}
	if localMode {
		bindIP := s.cfg.LocalBindIP
		if bindIP == "" {
			bindIP = "127.0.0.1"
		}
		hostConfig.PortBindings = nat.PortMap{
			nat.Port(internalPort + "/tcp"): []nat.PortBinding{{HostIP: bindIP, HostPort: ""}},
		}
	}

	envVars := []string{
		"OLLAMA_HOST=0.0.0.0:" + internalPort,
		"OLLAMA_KEEP_ALIVE=24h",
	}

	var netCfg *network.NetworkingConfig
	if !localMode {
		netCfg = &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				s.cfg.TraefikNetwork: {},
			},
		}
	}

	exposed := nat.PortSet{nat.Port(internalPort + "/tcp"): struct{}{}}
	resp, err := s.docker.ContainerCreate(
		ctx,
		&container.Config{
			Image:        s.cfg.OllamaImage,
			Env:          envVars,
			Labels:       labels,
			ExposedPorts: exposed,
		},
		hostConfig,
		netCfg,
		nil,
		containerName,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create: " + err.Error()})
		return
	}
	if err := s.docker.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = s.docker.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "start: " + err.Error()})
		return
	}
	s.startTail(req.ProjectID, resp.ID)

	// Fire ollama pull in background — large models take minutes; client request
	// must not block. Container's ollama daemon already running; pull only
	// affects model availability inside the daemon.
	go func(containerID, ref string) {
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		// Wait briefly for ollama daemon ready.
		for i := 0; i < 30; i++ {
			if _, err := s.execLines(bgCtx, containerID, []string{"ollama", "list"}); err == nil {
				break
			}
			time.Sleep(time.Second)
		}
		if _, err := s.execLines(bgCtx, containerID, []string{"ollama", "pull", ref}); err != nil {
			log.Printf("ollama pull %s failed: %v", ref, err)
		} else {
			log.Printf("ollama pull %s complete", ref)
		}
	}(resp.ID, req.RuntimeRef)

	hostPort := 11434
	apiURL := fmt.Sprintf("https://%s.%s/v1", req.Slug, s.cfg.SiteDomain)
	if localMode {
		host := s.cfg.LocalPublicHost
		if host == "" {
			host = "localhost"
		}
		insp, err := s.docker.ContainerInspect(ctx, resp.ID)
		if err == nil {
			if bindings, ok := insp.NetworkSettings.Ports["11434/tcp"]; ok && len(bindings) > 0 {
				if p := bindings[0].HostPort; p != "" {
					fmt.Sscanf(p, "%d", &hostPort)
				}
			}
		}
		apiURL = fmt.Sprintf("http://%s:%d/v1", host, hostPort)
	}

	c.JSON(http.StatusOK, createResp{
		ContainerID:   resp.ID,
		ContainerPort: hostPort,
		APIURL:        apiURL,
	})
}

func (s *server) createDMR(ctx context.Context, c *gin.Context, req createReq) {
	if _, err := exec.LookPath("docker"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "docker CLI not in PATH"})
		return
	}

	// Run pull async — large models take minutes. Synthetic container ID = "dmr:<ref>".
	go func(ref string) {
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		pull := exec.CommandContext(bgCtx, "docker", "model", "pull", ref)
		if out, err := pull.CombinedOutput(); err != nil {
			log.Printf("docker model pull %s failed: %v output=%s", ref, err, out)
		} else {
			log.Printf("docker model pull %s complete", ref)
		}
	}(req.RuntimeRef)

	containerID := "dmr:" + req.RuntimeRef

	host := s.cfg.LocalPublicHost
	if host == "" {
		host = "localhost"
	}
	port := 12434 // Docker Desktop's host-side DMR gateway
	if v := os.Getenv("DMR_HOST_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			port = n
		}
	}
	apiURL := fmt.Sprintf("http://%s:%d/engines/v1", host, port)

	c.JSON(http.StatusOK, createResp{
		ContainerID:   containerID,
		ContainerPort: port,
		APIURL:        apiURL,
	})
}

// ----- Stats -----

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

func calculateCPUPercent(stats container.StatsResponse) float64 {
	cpuStats := stats.CPUStats
	preCPUStats := stats.PreCPUStats
	if cpuStats.CPUUsage.TotalUsage <= preCPUStats.CPUUsage.TotalUsage ||
		cpuStats.SystemUsage <= preCPUStats.SystemUsage {
		return 0
	}
	cpuDelta := float64(cpuStats.CPUUsage.TotalUsage - preCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(cpuStats.SystemUsage - preCPUStats.SystemUsage)
	onlineCPUs := float64(cpuStats.OnlineCPUs)
	if onlineCPUs == 0 {
		onlineCPUs = float64(len(cpuStats.CPUUsage.PercpuUsage))
	}
	if onlineCPUs == 0 {
		onlineCPUs = 1
	}
	return (cpuDelta / systemDelta) * onlineCPUs * 100
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
	if strings.HasPrefix(req.ContainerID, "dmr:") {
		c.JSON(http.StatusOK, statsResp{
			ContainerID: req.ContainerID,
			Name:        strings.TrimPrefix(req.ContainerID, "dmr:"),
			ReadAt:      time.Now().UTC().Format(time.RFC3339Nano),
		})
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": "decode stats: " + err.Error()})
		return
	}

	memoryUsage := calculateMemoryUsage(stats)
	memoryLimit := stats.MemoryStats.Limit
	memoryPercent := 0.0
	if memoryLimit > 0 {
		memoryPercent = (float64(memoryUsage) / float64(memoryLimit)) * 100
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
		MemoryPercent:    memoryPercent,
		Pids:             stats.PidsStats.Current,
	})
}

func (s *server) handleStart(c *gin.Context) {
	var req startReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.HasPrefix(req.ContainerID, "dmr:") {
		// DMR is always-on through the gateway; no-op start.
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	ctx := c.Request.Context()
	if err := s.docker.ContainerStart(ctx, req.ContainerID, container.StartOptions{}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "start: " + err.Error()})
		return
	}
	if insp, ierr := s.docker.ContainerInspect(ctx, req.ContainerID); ierr == nil {
		if pid := insp.Config.Labels["orqestra.project_id"]; pid != "" {
			s.startTail(pid, req.ContainerID)
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) handleStop(c *gin.Context) {
	var req stopReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.HasPrefix(req.ContainerID, "dmr:") {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	ctx := c.Request.Context()
	if insp, ierr := s.docker.ContainerInspect(ctx, req.ContainerID); ierr == nil {
		if pid := insp.Config.Labels["orqestra.project_id"]; pid != "" {
			s.stopTail(pid)
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
	if strings.HasPrefix(req.ContainerID, "dmr:") {
		modelRef := strings.TrimPrefix(req.ContainerID, "dmr:")
		rm := exec.CommandContext(c.Request.Context(), "docker", "model", "rm", modelRef)
		if out, err := rm.CombinedOutput(); err != nil {
			log.Printf("docker model rm %s failed: %v output=%s", modelRef, err, out)
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	ctx := c.Request.Context()
	if insp, ierr := s.docker.ContainerInspect(ctx, req.ContainerID); ierr == nil {
		if pid := insp.Config.Labels["orqestra.project_id"]; pid != "" {
			s.stopTail(pid)
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

func main() {
	cfg := loadConfig()

	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		log.Fatalf("docker client: %v", err)
	}

	s := &server{cfg: cfg, docker: cli, tails: map[string]context.CancelFunc{}}

	// Pre-pull ollama base image in background so first user create doesn't
	// wait on the ~2GB download.
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := s.ensureImage(bgCtx, cfg.OllamaImage); err != nil {
			log.Printf("pre-pull %s failed: %v", cfg.OllamaImage, err)
		} else {
			log.Printf("pre-pulled %s", cfg.OllamaImage)
		}
	}()

	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true, "ts": fmt.Sprintf("%d", os.Getpid())})
	})

	// Capabilities is exposed without auth so the installer can probe before
	// the API is up; it returns no secrets.
	r.GET("/internal/hosting/capabilities", s.handleCapabilities)

	api := r.Group("/internal/hosting", internalAuth(cfg.InternalSecret))
	api.POST("/create", s.handleCreate)
	api.POST("/start", s.handleStart)
	api.POST("/stop", s.handleStop)
	api.POST("/destroy", s.handleDestroy)
	api.POST("/stats", s.handleStats)
	api.POST("/model-ready", s.handleModelReady)
	api.GET("/catalog/search", s.handleCatalogSearch)
	api.GET("/catalog/tags", s.handleCatalogTags)
	api.GET("/catalog/backends", s.handleCatalogBackends)

	log.Printf("orchestrator-hosting listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatal(err)
	}
}
