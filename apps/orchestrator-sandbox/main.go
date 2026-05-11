package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"encoding/pem"
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
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/ssh"
)

type config struct {
	Port           string
	InternalSecret string
	SiteDomain     string
	TraefikNetwork string
	LocalBindIP    string
	LocalPublicHost string
	RedisURL       string
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

// ---- Distro images ----

// Each distro builds to image tag `orqestra-sandbox-<key>:latest`. We use
// CMD=/usr/sbin/sshd -D so the container's lifetime tracks sshd. authorized_keys
// is uploaded as a tar into the container after create (per-sandbox key).

const dockerfileUbuntu22 = `FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server python3 python3-pip curl ca-certificates sudo vim \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/run/sshd /root/.ssh && chmod 700 /root/.ssh \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`

const dockerfileUbuntu24 = `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server python3 python3-pip curl ca-certificates sudo vim \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/run/sshd /root/.ssh && chmod 700 /root/.ssh \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`

const dockerfileDebian12 = `FROM debian:12
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server python3 python3-pip curl ca-certificates sudo vim \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/run/sshd /root/.ssh && chmod 700 /root/.ssh \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && ssh-keygen -A
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`

const dockerfileAlpine = `FROM alpine:3.20
RUN apk add --no-cache openssh python3 py3-pip curl ca-certificates sudo \
    && mkdir -p /root/.ssh && chmod 700 /root/.ssh \
    && ssh-keygen -A \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`

type distroSpec struct {
	Key      string
	Tag      string
	Dockerfile string
}

var distros = map[string]distroSpec{
	"ubuntu-22.04": {Key: "ubuntu-22.04", Tag: "orqestra-sandbox-ubuntu-22-04:latest", Dockerfile: dockerfileUbuntu22},
	"ubuntu-24.04": {Key: "ubuntu-24.04", Tag: "orqestra-sandbox-ubuntu-24-04:latest", Dockerfile: dockerfileUbuntu24},
	"debian-12":    {Key: "debian-12", Tag: "orqestra-sandbox-debian-12:latest", Dockerfile: dockerfileDebian12},
	"alpine-3.20":  {Key: "alpine-3.20", Tag: "orqestra-sandbox-alpine-3-20:latest", Dockerfile: dockerfileAlpine},
}

func validDistro(d string) bool {
	_, ok := distros[d]
	return ok
}

// ---- Server ----

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

func (s *server) ensureVolume(ctx context.Context, name string) error {
	if _, err := s.docker.VolumeInspect(ctx, name); err == nil {
		return nil
	} else if !client.IsErrNotFound(err) {
		return err
	}
	_, err := s.docker.VolumeCreate(ctx, volume.CreateOptions{Name: name})
	return err
}

// buildDistroImage builds the sandbox image for one distro using docker
// ImageBuild + a streamed in-memory tar context.
func (s *server) buildDistroImage(ctx context.Context, d distroSpec) error {
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, d.Tag); err == nil {
		return nil
	}

	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	hdr := &tar.Header{
		Name: "Dockerfile",
		Mode: 0o644,
		Size: int64(len(d.Dockerfile)),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if _, err := tw.Write([]byte(d.Dockerfile)); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}

	resp, err := s.docker.ImageBuild(ctx, &buf, types.ImageBuildOptions{
		Tags:        []string{d.Tag},
		Remove:      true,
		ForceRemove: true,
		PullParent:  true,
		Dockerfile:  "Dockerfile",
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Drain build output so it actually executes; log only errors.
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
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, d.Tag); err != nil {
		return fmt.Errorf("image %s not present after build: %w", d.Tag, err)
	}
	return nil
}

func (s *server) prebuildAll() {
	for _, d := range distros {
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		if err := s.buildDistroImage(bgCtx, d); err != nil {
			log.Printf("pre-build %s failed: %v", d.Tag, err)
		} else {
			log.Printf("pre-built %s", d.Tag)
		}
		cancel()
	}
}

// genKeypair returns OpenSSH-format public key (single line w/ trailing newline)
// and PEM-encoded private key.
func genKeypair() (pubAuthorizedKey, privPEM string, err error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return "", "", err
	}
	pubLine := string(ssh.MarshalAuthorizedKey(sshPub))

	privBlock, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		return "", "", err
	}
	pemBytes := pem.EncodeToMemory(privBlock)
	return pubLine, string(pemBytes), nil
}

// uploadAuthorizedKeys writes /root/.ssh/authorized_keys into the container.
func (s *server) uploadAuthorizedKeys(ctx context.Context, containerID, pubLine string) error {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{
		Name:     ".ssh/",
		Mode:     0o700,
		Typeflag: tar.TypeDir,
		Uid:      0,
		Gid:      0,
	}); err != nil {
		return err
	}
	content := []byte(pubLine)
	if err := tw.WriteHeader(&tar.Header{
		Name: ".ssh/authorized_keys",
		Mode: 0o600,
		Size: int64(len(content)),
		Uid:  0,
		Gid:  0,
	}); err != nil {
		return err
	}
	if _, err := tw.Write(content); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return s.docker.CopyToContainer(ctx, containerID, "/root", &buf, container.CopyToContainerOptions{
		AllowOverwriteDirWithFile: false,
	})
}

// ---- Request/response types ----

type createReq struct {
	ProjectID   string  `json:"projectId" binding:"required"`
	Slug        string  `json:"slug" binding:"required"`
	UserID      string  `json:"userId" binding:"required"`
	Distro      string  `json:"distro" binding:"required"`
	VolumeName  string  `json:"volumeName" binding:"required"`
	CPULimit    string  `json:"cpuLimit"`
	MemoryLimit string  `json:"memoryLimit"`
	GPUIndex    *int    `json:"gpuIndex"`
	VramLimitMB int64   `json:"vramLimitMB"`
}

type createResp struct {
	ContainerID    string `json:"containerId"`
	ContainerPort  int    `json:"containerPort"`
	SSHHost        string `json:"sshHost"`
	SSHUser        string `json:"sshUser"`
	PublicKey      string `json:"publicKey"`
	PrivateKey     string `json:"privateKey"`
	SSHCommand     string `json:"sshCommand"`
}

type startReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type startResp struct {
	ContainerPort int    `json:"containerPort"`
	SSHCommand    string `json:"sshCommand"`
}

type stopReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type destroyReq struct {
	ContainerID string `json:"containerId" binding:"required"`
	VolumeName  string `json:"volumeName" binding:"required"`
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
	if !validDistro(req.Distro) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid distro"})
		return
	}
	ctx := c.Request.Context()

	if err := s.ensureVolume(ctx, req.VolumeName); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "volume: " + err.Error()})
		return
	}
	d := distros[req.Distro]
	if err := s.buildDistroImage(ctx, d); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "build image: " + err.Error()})
		return
	}

	pubLine, privPEM, err := genKeypair()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "keygen: " + err.Error()})
		return
	}

	labels := map[string]string{
		"orqestra.project_id": req.ProjectID,
		"orqestra.user_id":    req.UserID,
		"orqestra.kind":       "sandbox",
		"orqestra.distro":     req.Distro,
	}
	if req.GPUIndex != nil {
		labels["orqestra.gpu_index"] = strconv.Itoa(*req.GPUIndex)
		if req.VramLimitMB > 0 {
			labels["orqestra.vram_limit_mb"] = strconv.FormatInt(req.VramLimitMB, 10)
		}
	}

	bindIP := s.cfg.LocalBindIP
	if bindIP == "" {
		bindIP = "127.0.0.1"
	}

	hostConfig := &container.HostConfig{
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		Binds:         []string{fmt.Sprintf("%s:/root/work", req.VolumeName)},
		PortBindings: nat.PortMap{
			nat.Port("22/tcp"): []nat.PortBinding{{HostIP: bindIP, HostPort: ""}},
		},
	}
	if req.CPULimit != "" {
		hostConfig.NanoCPUs = parseCPU(req.CPULimit)
	}
	if req.MemoryLimit != "" {
		hostConfig.Memory = parseMemory(req.MemoryLimit)
	}
	if req.GPUIndex != nil {
		hostConfig.DeviceRequests = []container.DeviceRequest{{
			Driver:       "nvidia",
			Capabilities: [][]string{{"gpu"}},
			DeviceIDs:    []string{strconv.Itoa(*req.GPUIndex)},
		}}
	}

	exposed := nat.PortSet{nat.Port("22/tcp"): struct{}{}}

	var netCfg *network.NetworkingConfig
	// Sandbox is localhost-only (per v0). No traefik attachment.
	_ = netCfg

	resp, err := s.docker.ContainerCreate(
		ctx,
		&container.Config{
			Image:        d.Tag,
			Labels:       labels,
			ExposedPorts: exposed,
		},
		hostConfig,
		netCfg,
		nil,
		"orqestra-sandbox-"+req.Slug,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "create: " + err.Error()})
		return
	}

	// Upload authorized_keys BEFORE start so sshd reads them on first boot.
	if err := s.uploadAuthorizedKeys(ctx, resp.ID, pubLine); err != nil {
		_ = s.docker.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload keys: " + err.Error()})
		return
	}

	if err := s.docker.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = s.docker.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		c.JSON(http.StatusInternalServerError, gin.H{"error": "start: " + err.Error()})
		return
	}
	s.startTail(req.ProjectID, resp.ID)

	hostPort, err := s.lookupHostPort(ctx, resp.ID)
	if err != nil {
		log.Printf("lookup port: %v", err)
	}
	host := s.cfg.LocalPublicHost
	if host == "" {
		host = "localhost"
	}
	sshCmd := fmt.Sprintf("ssh -p %d -i <private-key-file> root@%s", hostPort, host)

	c.JSON(http.StatusOK, createResp{
		ContainerID:   resp.ID,
		ContainerPort: hostPort,
		SSHHost:       host,
		SSHUser:       "root",
		PublicKey:     pubLine,
		PrivateKey:    privPEM,
		SSHCommand:    sshCmd,
	})
}

func (s *server) lookupHostPort(ctx context.Context, containerID string) (int, error) {
	insp, err := s.docker.ContainerInspect(ctx, containerID)
	if err != nil {
		return 0, err
	}
	if bindings, ok := insp.NetworkSettings.Ports["22/tcp"]; ok && len(bindings) > 0 {
		if p := bindings[0].HostPort; p != "" {
			n, _ := strconv.Atoi(p)
			return n, nil
		}
	}
	return 0, fmt.Errorf("no host port bound")
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
		if pid := insp.Config.Labels["orqestra.project_id"]; pid != "" {
			s.startTail(pid, req.ContainerID)
		}
	}
	hostPort, _ := s.lookupHostPort(ctx, req.ContainerID)
	host := s.cfg.LocalPublicHost
	if host == "" {
		host = "localhost"
	}
	c.JSON(http.StatusOK, startResp{
		ContainerPort: hostPort,
		SSHCommand:    fmt.Sprintf("ssh -p %d -i <private-key-file> root@%s", hostPort, host),
	})
}

func (s *server) handleStop(c *gin.Context) {
	var req stopReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
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
	if err := s.docker.VolumeRemove(ctx, req.VolumeName, true); err != nil && !client.IsErrNotFound(err) {
		log.Printf("volume remove failed: %v", err)
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
	s := &server{cfg: cfg, docker: cli, tails: map[string]context.CancelFunc{}}

	// Pre-build all 4 distro images so first create doesn't block on apt.
	go s.prebuildAll()

	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	api := r.Group("/internal/sandbox", internalAuth(cfg.InternalSecret))
	api.POST("/create", s.handleCreate)
	api.POST("/start", s.handleStart)
	api.POST("/stop", s.handleStop)
	api.POST("/destroy", s.handleDestroy)
	api.POST("/stats", s.handleStats)

	log.Printf("orchestrator-sandbox listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatal(err)
	}
}
