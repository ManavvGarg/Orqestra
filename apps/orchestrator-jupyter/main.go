package main

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/gin-gonic/gin"
)

type config struct {
	Port              string
	InternalSecret    string
	SiteDomain        string
	TraefikNetwork    string
	CertResolver      string
	JupyterEntrypoint string
	RedisURL          string
}

func loadConfig() config {
	get := func(k, fallback string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return fallback
	}
	cfg := config{
		Port:              get("PORT", "8080"),
		InternalSecret:    os.Getenv("INTERNAL_API_SECRET"),
		SiteDomain:        get("SITE_DOMAIN", "orqestra.xyz"),
		TraefikNetwork:    get("TRAEFIK_NETWORK", "proxy"),
		CertResolver:      get("CERT_RESOLVER", "letsencrypt"),
		JupyterEntrypoint: get("JUPYTER_ENTRYPOINT", "websecure"),
		RedisURL:          get("REDIS_URL", "redis://redis:6379"),
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

func randomToken(byteLen int) (string, error) {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func imageFor(jobType string) string {
	switch jobType {
	case "tensorflow":
		return "jupyter/tensorflow-notebook:latest"
	case "pytorch":
		return "jupyter/pytorch-notebook:latest"
	case "r":
		return "jupyter/r-notebook:latest"
	default:
		return "jupyter/base-notebook:latest"
	}
}

type createReq struct {
	ProjectID   string `json:"projectId" binding:"required"`
	Slug        string `json:"slug" binding:"required"`
	UserID      string `json:"userId" binding:"required"`
	JobType     string `json:"jobType" binding:"required"`
	VolumeName  string `json:"volumeName" binding:"required"`
	CPULimit    string `json:"cpuLimit"`
	MemoryLimit string `json:"memoryLimit"`
	GPUIndex    *int   `json:"gpuIndex"`
	VramLimitMB *int64 `json:"vramLimitMB"`
}

type createResp struct {
	ContainerID     string `json:"containerId"`
	ContainerURL    string `json:"containerUrl"`
	ContainerToken  string `json:"containerToken"`
	ContainerPort   int    `json:"containerPort"`
}

type stopReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type startReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type listReq struct {
	ContainerID string `json:"containerId" binding:"required"`
	Path        string `json:"path" binding:"required"`
}

type fileEntry struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	ModifiedAt int64  `json:"modifiedAt"`
}

type listResp struct {
	Path    string      `json:"path"`
	Entries []fileEntry `json:"entries"`
}

type downloadReq struct {
	ContainerID string `json:"containerId" binding:"required"`
	Path        string `json:"path" binding:"required"`
}

type startResp struct {
	ContainerURL  string `json:"containerUrl"`
	ContainerPort int    `json:"containerPort"`
}

type destroyReq struct {
	ContainerID string `json:"containerId" binding:"required"`
	VolumeName  string `json:"volumeName" binding:"required"`
}

type statsReq struct {
	ContainerID string `json:"containerId" binding:"required"`
}

type statsResp struct {
	ContainerID          string  `json:"containerId"`
	Name                 string  `json:"name"`
	ReadAt               string  `json:"readAt"`
	CPUPercent           float64 `json:"cpuPercent"`
	MemoryUsageBytes     uint64  `json:"memoryUsageBytes"`
	MemoryRawUsageBytes  uint64  `json:"memoryRawUsageBytes"`
	MemoryLimitBytes     uint64  `json:"memoryLimitBytes"`
	MemoryPercent        float64 `json:"memoryPercent"`
	Pids                 uint64  `json:"pids"`
}

type server struct {
	cfg     config
	docker  *client.Client
	tailsMu sync.Mutex
	tails   map[string]context.CancelFunc // projectId → cancel
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

func (s *server) ensureImage(ctx context.Context, ref string) error {
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, ref); err == nil {
		return nil
	}
	log.Printf("pulling image %s…", ref)
	rc, err := s.docker.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull: %w", err)
	}
	defer rc.Close()
	if _, err := io.Copy(io.Discard, rc); err != nil {
		return fmt.Errorf("pull stream: %w", err)
	}
	log.Printf("pulled %s", ref)
	return nil
}

func (s *server) ensureVolume(ctx context.Context, name string) error {
	_, err := s.docker.VolumeInspect(ctx, name)
	if err == nil {
		return nil
	}
	if !client.IsErrNotFound(err) {
		return err
	}
	_, err = s.docker.VolumeCreate(ctx, volume.CreateOptions{Name: name})
	return err
}

func (s *server) handleCreate(c *gin.Context) {
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validJobType(req.JobType) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid jobType"})
		return
	}
	ctx := c.Request.Context()

	token, err := randomToken(16)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if err := s.ensureVolume(ctx, req.VolumeName); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "volume: " + err.Error()})
		return
	}

	imageRef := imageFor(req.JobType)
	if err := s.ensureImage(ctx, imageRef); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "image: " + err.Error()})
		return
	}

	localMode := s.cfg.SiteDomain == "localhost"

	labels := map[string]string{
		"orqestra.project_id": req.ProjectID,
		"orqestra.user_id":    req.UserID,
		"orqestra.kind":       "jupyter",
	}
	if !localMode {
		hostRule := fmt.Sprintf("Host(`%s.%s`)", req.Slug, s.cfg.SiteDomain)
		labels["traefik.enable"] = "true"
		labels[fmt.Sprintf("traefik.http.routers.%s.rule", req.Slug)] = hostRule
		labels[fmt.Sprintf("traefik.http.routers.%s.entrypoints", req.Slug)] = s.cfg.JupyterEntrypoint
		labels[fmt.Sprintf("traefik.http.routers.%s.tls", req.Slug)] = "true"
		labels[fmt.Sprintf("traefik.http.routers.%s.tls.certresolver", req.Slug)] = s.cfg.CertResolver
		labels[fmt.Sprintf("traefik.http.services.%s.loadbalancer.server.port", req.Slug)] = "8888"
	}

	hostConfig := &container.HostConfig{
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		Mounts:        nil,
		Binds:         []string{fmt.Sprintf("%s:/home/jovyan/work", req.VolumeName)},
	}
	if localMode {
		bindIP := os.Getenv("LOCAL_BIND_IP")
		if bindIP == "" {
			bindIP = "127.0.0.1"
		}
		hostConfig.PortBindings = nat.PortMap{
			nat.Port("8888/tcp"): []nat.PortBinding{{HostIP: bindIP, HostPort: ""}},
		}
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

	envVars := []string{
		"JUPYTER_TOKEN=" + token,
		"JUPYTER_ENABLE_LAB=yes",
	}

	exposed := nat.PortSet{nat.Port("8888/tcp"): struct{}{}}

	var netCfg *network.NetworkingConfig
	if !localMode {
		netCfg = &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				s.cfg.TraefikNetwork: {},
			},
		}
	}

	resp, err := s.docker.ContainerCreate(
		ctx,
		&container.Config{
			Image:        imageRef,
			Env:          envVars,
			Labels:       labels,
			ExposedPorts: exposed,
		},
		hostConfig,
		netCfg,
		nil,
		"orqestra-jupyter-"+req.Slug,
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

	hostPort := 8888
	url := fmt.Sprintf("https://%s.%s/?token=%s", req.Slug, s.cfg.SiteDomain, token)

	if localMode {
		inspected, err := s.docker.ContainerInspect(ctx, resp.ID)
		if err == nil {
			if bindings, ok := inspected.NetworkSettings.Ports["8888/tcp"]; ok && len(bindings) > 0 {
				if p := bindings[0].HostPort; p != "" {
					fmt.Sscanf(p, "%d", &hostPort)
				}
			}
		}
		host := os.Getenv("LOCAL_PUBLIC_HOST")
		if host == "" {
			host = "localhost"
		}
		url = fmt.Sprintf("http://%s:%d/?token=%s", host, hostPort, token)
	}

	c.JSON(http.StatusOK, createResp{
		ContainerID:    resp.ID,
		ContainerURL:   url,
		ContainerToken: token,
		ContainerPort:  hostPort,
	})
}

const fileRoot = "/home/jovyan"

func sanitizePath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("empty path")
	}
	if !strings.HasPrefix(p, "/") {
		p = path.Join(fileRoot, p)
	}
	clean := path.Clean(p)
	if clean != fileRoot && !strings.HasPrefix(clean, fileRoot+"/") {
		return "", fmt.Errorf("path outside %s", fileRoot)
	}
	return clean, nil
}

func (s *server) execCapture(ctx context.Context, containerID string, cmd []string) (stdout, stderr string, exitCode int, err error) {
	exec, err := s.docker.ContainerExecCreate(ctx, containerID, container.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return "", "", 0, err
	}
	hijack, err := s.docker.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{})
	if err != nil {
		return "", "", 0, err
	}
	defer hijack.Close()

	var outBuf, errBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(&outBuf, &errBuf, hijack.Reader); err != nil {
		return "", "", 0, err
	}

	insp, err := s.docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return outBuf.String(), errBuf.String(), 0, err
	}
	return outBuf.String(), errBuf.String(), insp.ExitCode, nil
}

func parseLsOutput(s string) []fileEntry {
	out := []fileEntry{} // non-nil so JSON serialises as [] not null
	for _, line := range strings.Split(strings.TrimRight(s, "\n"), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		mode := fields[0]
		if mode == "total" {
			continue
		}
		size, _ := strconv.ParseInt(fields[4], 10, 64)
		mtime, _ := strconv.ParseInt(fields[5], 10, 64)
		name := strings.Join(fields[6:], " ")
		if name == "." || name == ".." {
			continue
		}
		etype := "file"
		if len(mode) > 0 {
			switch mode[0] {
			case 'd':
				etype = "dir"
			case 'l':
				etype = "symlink"
			}
		}
		out = append(out, fileEntry{Name: name, Type: etype, Size: size, ModifiedAt: mtime})
	}
	return out
}

func (s *server) handleList(c *gin.Context) {
	var req listReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	clean, err := sanitizePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()
	cmd := []string{"sh", "-c", fmt.Sprintf("ls -la --time-style=+%%s %q", clean)}
	stdout, stderr, code, err := s.execCapture(ctx, req.ContainerID, cmd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if code != 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ls failed", "stderr": stderr})
		return
	}
	c.JSON(http.StatusOK, listResp{Path: clean, Entries: parseLsOutput(stdout)})
}

func (s *server) handleDownload(c *gin.Context) {
	var req downloadReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	clean, err := sanitizePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()

	stat, err := s.docker.ContainerStatPath(ctx, req.ContainerID, clean)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	rc, _, err := s.docker.CopyFromContainer(ctx, req.ContainerID, clean)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rc.Close()

	isDir := stat.Mode.IsDir()
	if isDir {
		c.Header("Content-Type", "application/x-tar")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", path.Base(clean)+".tar"))
		if _, err := io.Copy(c.Writer, rc); err != nil {
			log.Printf("tar copy: %v", err)
		}
		return
	}

	tr := tar.NewReader(rc)
	hdr, err := tr.Next()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "empty archive"})
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", path.Base(hdr.Name)))
	c.Header("Content-Length", strconv.FormatInt(hdr.Size, 10))
	if _, err := io.Copy(c.Writer, tr); err != nil {
		log.Printf("file copy: %v", err)
	}
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
	memoryRawUsage := stats.MemoryStats.Usage
	if memoryRawUsage == 0 && stats.MemoryStats.PrivateWorkingSet > 0 {
		memoryRawUsage = stats.MemoryStats.PrivateWorkingSet
	}
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
		ContainerID:         stats.ID,
		Name:                strings.TrimPrefix(stats.Name, "/"),
		ReadAt:              readAt,
		CPUPercent:          calculateCPUPercent(stats),
		MemoryUsageBytes:    memoryUsage,
		MemoryRawUsageBytes: memoryRawUsage,
		MemoryLimitBytes:    memoryLimit,
		MemoryPercent:       memoryPercent,
		Pids:                stats.PidsStats.Current,
	})
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
		if pid, ok := insp.Config.Labels["orqestra.project_id"]; ok && pid != "" {
			s.startTail(pid, req.ContainerID)
		}
	}

	hostPort := 8888
	resp := startResp{ContainerPort: hostPort}

	if s.cfg.SiteDomain == "localhost" {
		inspected, err := s.docker.ContainerInspect(ctx, req.ContainerID)
		if err == nil {
			if bindings, ok := inspected.NetworkSettings.Ports["8888/tcp"]; ok && len(bindings) > 0 {
				if p := bindings[0].HostPort; p != "" {
					fmt.Sscanf(p, "%d", &hostPort)
				}
			}
			host := os.Getenv("LOCAL_PUBLIC_HOST")
			if host == "" {
				host = "localhost"
			}
			tokenEnv := ""
			for _, e := range inspected.Config.Env {
				if strings.HasPrefix(e, "JUPYTER_TOKEN=") {
					tokenEnv = strings.TrimPrefix(e, "JUPYTER_TOKEN=")
					break
				}
			}
			resp.ContainerPort = hostPort
			resp.ContainerURL = fmt.Sprintf("http://%s:%d/?token=%s", host, hostPort, tokenEnv)
		}
	}

	c.JSON(http.StatusOK, resp)
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

func validJobType(j string) bool {
	switch j {
	case "base", "tensorflow", "pytorch", "r":
		return true
	}
	return false
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

	// Pre-pull all four Jupyter base images so first user create doesn't block
	// on the multi-GB download. Sequential — pulling four ~5GB images in
	// parallel saturates disk + bandwidth.
	go func() {
		for _, jobType := range []string{"base", "tensorflow", "pytorch", "r"} {
			ref := imageFor(jobType)
			bgCtx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
			if err := s.ensureImage(bgCtx, ref); err != nil {
				log.Printf("pre-pull %s failed: %v", ref, err)
			} else {
				log.Printf("pre-pulled %s", ref)
			}
			cancel()
		}
	}()

	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	api := r.Group("/internal/jupyter", internalAuth(cfg.InternalSecret))
	api.POST("/create", s.handleCreate)
	api.POST("/start", s.handleStart)
	api.POST("/stop", s.handleStop)
	api.POST("/destroy", s.handleDestroy)
	api.POST("/list", s.handleList)
	api.POST("/download", s.handleDownload)
	api.POST("/stats", s.handleStats)

	log.Printf("orchestrator-jupyter listening on :%s", cfg.Port)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatal(err)
	}
}
