package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/gin-gonic/gin"
)

// ----------------------------------------------------------------
// Public DTOs returned to api/web
// ----------------------------------------------------------------

type catalogModel struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Backend     string `json:"backend"`     // llama.cpp / vllm / "" for ollama-side / etc.
	Source      string `json:"source"`      // "Docker Hub" / "HuggingFace" / "Ollama"
	Provider    string `json:"provider"`    // "dmr" / "ollama"
	PullCount   int    `json:"pullCount"`
	StarCount   int    `json:"starCount"`
}

type catalogTag struct {
	Name        string `json:"name"`
	SizeBytes   int64  `json:"sizeBytes"`
	LastUpdated string `json:"lastUpdated"`
}

type catalogBackends struct {
	DMRInstalled  bool     `json:"dmrInstalled"`
	DMRBackends   []string `json:"dmrBackends"` // Running backend names
	OllamaPresent bool     `json:"ollamaPresent"`
}

// ----------------------------------------------------------------
// HTTP helper
// ----------------------------------------------------------------

func httpGetJSON(ctx context.Context, u string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "orqestra-hosting/1.0")
	cli := &http.Client{Timeout: 12 * time.Second}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("hub %d: %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ----------------------------------------------------------------
// Backend detection (cached)
// ----------------------------------------------------------------

var (
	backendsMu     sync.Mutex
	backendsCache  *catalogBackends
	backendsCachedAt time.Time
)

func detectBackends(ctx context.Context) catalogBackends {
	backendsMu.Lock()
	defer backendsMu.Unlock()
	if backendsCache != nil && time.Since(backendsCachedAt) < 30*time.Second {
		return *backendsCache
	}
	cb := catalogBackends{}
	if _, err := exec.LookPath("docker"); err == nil {
		cmd := exec.CommandContext(ctx, "docker", "model", "status")
		out, err := cmd.CombinedOutput()
		if err == nil && strings.Contains(string(out), "Docker Model Runner is running") {
			cb.DMRInstalled = true
			// Parse table for "Running" backends.
			for _, line := range strings.Split(string(out), "\n") {
				fields := strings.Fields(line)
				if len(fields) >= 2 && fields[1] == "Running" {
					cb.DMRBackends = append(cb.DMRBackends, fields[0])
				}
			}
		}
		// Ollama presence: image pulled OR container named "ollama" running. Cheap check
		// — see if the image exists locally.
		img := exec.CommandContext(ctx, "docker", "image", "inspect", "ollama/ollama:latest")
		if err := img.Run(); err == nil {
			cb.OllamaPresent = true
		}
	}
	backendsCache = &cb
	backendsCachedAt = time.Now()
	return cb
}

func (s *server) handleCatalogBackends(c *gin.Context) {
	c.JSON(http.StatusOK, detectBackends(c.Request.Context()))
}

// ----------------------------------------------------------------
// Search: combine `docker model search` (DMR catalog) + Ollama library
// ----------------------------------------------------------------

func parseDockerModelSearch(out string) []catalogModel {
	lines := strings.Split(out, "\n")
	if len(lines) < 1 {
		return nil
	}
	header := lines[0]
	colStart := func(name string) int { return strings.Index(header, name) }
	starts := []int{
		colStart("NAME"),
		colStart("DESCRIPTION"),
		colStart("BACKEND"),
		colStart("DOWNLOADS"),
		colStart("STARS"),
		colStart("SOURCE"),
	}
	get := func(line string, i int) string {
		if i >= len(starts) || starts[i] < 0 || starts[i] >= len(line) {
			return ""
		}
		end := len(line)
		if i+1 < len(starts) && starts[i+1] >= 0 && starts[i+1] <= len(line) {
			end = starts[i+1]
		}
		return strings.TrimSpace(line[starts[i]:end])
	}
	var rows []catalogModel
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		name := get(line, 0)
		if name == "" {
			continue
		}
		src := get(line, 5)
		provider := "dmr"
		if strings.HasPrefix(name, "hf.co/") {
			provider = "huggingface"
		}
		rows = append(rows, catalogModel{
			Name:        name,
			Description: get(line, 1),
			Backend:     get(line, 2),
			PullCount:   parseHumanCount(get(line, 3)),
			StarCount:   atoiSafe(strings.TrimSpace(get(line, 4))),
			Source:      src,
			Provider:    provider,
		})
	}
	return rows
}

func parseHumanCount(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	last := s[len(s)-1]
	mul := 1.0
	switch last {
	case 'K':
		mul = 1e3
	case 'M':
		mul = 1e6
	case 'B':
		mul = 1e9
	default:
		n, _ := strconv.Atoi(s)
		return n
	}
	n, _ := strconv.ParseFloat(s[:len(s)-1], 64)
	return int(n * mul)
}

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// Hub-API fallback: list ai/* by pull count.
type hubListResp struct {
	Results []struct {
		Name        string `json:"name"`
		Namespace   string `json:"namespace"`
		Description string `json:"description"`
		PullCount   int    `json:"pull_count"`
		StarCount   int    `json:"star_count"`
	} `json:"results"`
	Next string `json:"next"`
}

type hubSearchResp struct {
	Results []struct {
		RepoName         string `json:"repo_name"`
		ShortDescription string `json:"short_description"`
		PullCount        int    `json:"pull_count"`
		StarCount        int    `json:"star_count"`
	} `json:"results"`
}

func searchHubAI(ctx context.Context, q string) ([]catalogModel, error) {
	var models []catalogModel
	if q == "" {
		var resp hubListResp
		u := "https://hub.docker.com/v2/repositories/ai/?page_size=100&ordering=-pull_count"
		if err := httpGetJSON(ctx, u, &resp); err != nil {
			return nil, err
		}
		for _, r := range resp.Results {
			ns := r.Namespace
			if ns == "" {
				ns = "ai"
			}
			models = append(models, catalogModel{
				Name:        ns + "/" + r.Name,
				Description: r.Description,
				Source:      "Docker Hub",
				Provider:    "dmr",
				PullCount:   r.PullCount,
				StarCount:   r.StarCount,
			})
		}
	} else {
		var resp hubSearchResp
		u := "https://hub.docker.com/v2/search/repositories/?page_size=50&query=" + url.QueryEscape(q)
		if err := httpGetJSON(ctx, u, &resp); err != nil {
			return nil, err
		}
		for _, r := range resp.Results {
			if !strings.HasPrefix(r.RepoName, "ai/") {
				continue
			}
			models = append(models, catalogModel{
				Name:        r.RepoName,
				Description: r.ShortDescription,
				Source:      "Docker Hub",
				Provider:    "dmr",
				PullCount:   r.PullCount,
				StarCount:   r.StarCount,
			})
		}
	}
	return models, nil
}

// ----------------------------------------------------------------
// Ollama library
// ----------------------------------------------------------------
//
// Ollama publishes a JSON list at https://ollama.com/library.json (community-maintained).
// As a stable fallback we keep a small curated set; if the live endpoint responds we
// merge results.
//
type ollamaLibraryEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	PullCount   int    `json:"pulls"`
	Tags        []struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	} `json:"tags"`
}

var ollamaCurated = []catalogModel{
	{Name: "llama3.2", Description: "Meta Llama 3.2 — 1B / 3B parameters", Source: "Ollama", Provider: "ollama"},
	{Name: "llama3.1", Description: "Meta Llama 3.1 — 8B / 70B / 405B", Source: "Ollama", Provider: "ollama"},
	{Name: "qwen2.5", Description: "Alibaba Qwen 2.5 — 0.5B–72B", Source: "Ollama", Provider: "ollama"},
	{Name: "qwen2.5-coder", Description: "Code-tuned Qwen 2.5 — 0.5B–32B", Source: "Ollama", Provider: "ollama"},
	{Name: "qwen3", Description: "Alibaba Qwen 3", Source: "Ollama", Provider: "ollama"},
	{Name: "mistral", Description: "Mistral 7B base", Source: "Ollama", Provider: "ollama"},
	{Name: "mistral-nemo", Description: "Mistral Nemo 12B", Source: "Ollama", Provider: "ollama"},
	{Name: "mixtral", Description: "Mixtral 8x7B / 8x22B MoE", Source: "Ollama", Provider: "ollama"},
	{Name: "gemma2", Description: "Google Gemma 2 — 2B / 9B / 27B", Source: "Ollama", Provider: "ollama"},
	{Name: "gemma3", Description: "Google Gemma 3", Source: "Ollama", Provider: "ollama"},
	{Name: "phi3", Description: "Microsoft Phi-3 — 3.8B / 14B", Source: "Ollama", Provider: "ollama"},
	{Name: "phi4", Description: "Microsoft Phi-4 14B", Source: "Ollama", Provider: "ollama"},
	{Name: "deepseek-r1", Description: "DeepSeek R1 reasoning", Source: "Ollama", Provider: "ollama"},
	{Name: "deepseek-coder-v2", Description: "DeepSeek Coder V2", Source: "Ollama", Provider: "ollama"},
	{Name: "codellama", Description: "Meta Code Llama", Source: "Ollama", Provider: "ollama"},
	{Name: "smollm2", Description: "SmolLM2 — 135M / 360M / 1.7B", Source: "Ollama", Provider: "ollama"},
	{Name: "nomic-embed-text", Description: "Embedding model — 137M params", Source: "Ollama", Provider: "ollama"},
	{Name: "all-minilm", Description: "Embedding model — sentence-transformers MiniLM", Source: "Ollama", Provider: "ollama"},
	{Name: "llava", Description: "LLaVA multimodal — 7B / 13B / 34B", Source: "Ollama", Provider: "ollama"},
	{Name: "moondream", Description: "Tiny vision LM — 1.8B", Source: "Ollama", Provider: "ollama"},
}

func searchOllama(q string) []catalogModel {
	q = strings.ToLower(q)
	if q == "" {
		out := make([]catalogModel, len(ollamaCurated))
		copy(out, ollamaCurated)
		return out
	}
	var out []catalogModel
	for _, m := range ollamaCurated {
		if strings.Contains(strings.ToLower(m.Name), q) ||
			strings.Contains(strings.ToLower(m.Description), q) {
			out = append(out, m)
		}
	}
	return out
}

// ----------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------

var (
	searchCacheMu sync.Mutex
	searchCache   = map[string]searchCacheEntry{}
)

type searchCacheEntry struct {
	models []catalogModel
	at     time.Time
}

const searchCacheTTL = 5 * time.Minute

func (s *server) handleCatalogSearch(c *gin.Context) {
	q := c.DefaultQuery("q", "")
	provider := c.DefaultQuery("provider", "") // "dmr" / "ollama" / ""
	ctx := c.Request.Context()

	cacheKey := provider + "|" + q
	searchCacheMu.Lock()
	if e, ok := searchCache[cacheKey]; ok && time.Since(e.at) < searchCacheTTL {
		models := e.models
		searchCacheMu.Unlock()
		c.JSON(http.StatusOK, gin.H{"models": models, "cached": true})
		return
	}
	searchCacheMu.Unlock()

	var combined []catalogModel

	if provider == "" || provider == "dmr" {
		// Bound `docker model search` to 5s — falls back to Hub API if slow.
		var dmr []catalogModel
		if _, err := exec.LookPath("docker"); err == nil {
			searchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			args := []string{"model", "search"}
			if q != "" {
				args = append(args, q)
			}
			cmd := exec.CommandContext(searchCtx, "docker", args...)
			out, err := cmd.CombinedOutput()
			cancel()
			if err == nil {
				dmr = parseDockerModelSearch(string(out))
			}
		}
		if len(dmr) == 0 {
			hubCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			hub, err := searchHubAI(hubCtx, q)
			cancel()
			if err == nil {
				dmr = hub
			}
		}
		combined = append(combined, dmr...)
	}

	if provider == "" || provider == "ollama" {
		combined = append(combined, searchOllama(q)...)
	}

	searchCacheMu.Lock()
	searchCache[cacheKey] = searchCacheEntry{models: combined, at: time.Now()}
	searchCacheMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"models": combined, "cached": false})
}

type hubTagsResp struct {
	Results []struct {
		Name        string `json:"name"`
		FullSize    int64  `json:"full_size"`
		LastUpdated string `json:"last_updated"`
		TagStatus   string `json:"tag_status"`
	} `json:"results"`
}

// scrapeOllamaTags fetches https://ollama.com/library/<name>/tags and extracts
// `<name>:<tag>` references. Sizes parsed from the page when present.
func scrapeOllamaTags(ctx context.Context, name string) ([]catalogTag, error) {
	if name == "" {
		return nil, fmt.Errorf("empty model name")
	}
	// Try non-namespaced (library/<name>) first.
	url1 := "https://ollama.com/library/" + name + "/tags"
	body, err := scrapeFetch(ctx, url1)
	if err != nil && !strings.Contains(name, "/") {
		return nil, err
	}
	if err != nil {
		// Try as user/<name>
		url2 := "https://ollama.com/" + name + "/tags"
		body, err = scrapeFetch(ctx, url2)
		if err != nil {
			return nil, err
		}
	}

	// Match: /library/<name>:<tag> or /<user>/<name>:<tag>
	pattern := `/(?:library/)?` + regexp.QuoteMeta(strings.TrimPrefix(name, "library/")) + `:([a-zA-Z0-9._-]+)`
	re := regexp.MustCompile(pattern)
	matches := re.FindAllStringSubmatch(string(body), -1)
	seen := map[string]bool{}
	var out []catalogTag
	for _, m := range matches {
		t := m[1]
		if seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, catalogTag{Name: t})
	}
	// Stable order: latest first if present, then alphabetic.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Name == "latest" {
			return true
		}
		if out[j].Name == "latest" {
			return false
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

func scrapeFetch(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 orqestra-hosting/1.0")
	req.Header.Set("Accept", "text/html")
	cli := &http.Client{Timeout: 12 * time.Second}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// ----------------------------------------------------------------
// Model-ready check (used by API background poller)
// ----------------------------------------------------------------

type modelReadyReq struct {
	ContainerID string `json:"containerId" binding:"required"`
	Ref         string `json:"ref" binding:"required"`
	Runtime     string `json:"runtime" binding:"required"` // "ollama" / "docker-model-runner"
}

type modelReadyResp struct {
	Ready bool   `json:"ready"`
	Error string `json:"error,omitempty"`
}

func (s *server) handleModelReady(c *gin.Context) {
	var req modelReadyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx := c.Request.Context()

	switch req.Runtime {
	case "docker-model-runner":
		// `docker model ls` lists pulled models. If ref present → ready.
		cmd := exec.CommandContext(ctx, "docker", "model", "ls")
		out, err := cmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusOK, modelReadyResp{Ready: false, Error: err.Error()})
			return
		}
		// Strip tag for matching: `ai/qwen2.5:latest` → `ai/qwen2.5`
		base := req.Ref
		if i := strings.IndexByte(base, ':'); i != -1 {
			base = base[:i]
		}
		c.JSON(http.StatusOK, modelReadyResp{Ready: strings.Contains(string(out), base)})
		return

	case "ollama":
		// `ollama show <ref>` returns 0 only when the model is fully present.
		// Use that as the readiness gate — `ollama list` may include rows for
		// in-progress pulls or partial layers depending on daemon version.
		exec, err := s.docker.ContainerExecCreate(ctx, req.ContainerID, container.ExecOptions{
			Cmd:          []string{"ollama", "show", req.Ref},
			AttachStdout: true,
			AttachStderr: true,
		})
		if err != nil {
			c.JSON(http.StatusOK, modelReadyResp{Ready: false, Error: err.Error()})
			return
		}
		hijack, err := s.docker.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{})
		if err != nil {
			c.JSON(http.StatusOK, modelReadyResp{Ready: false, Error: err.Error()})
			return
		}
		_, _ = io.Copy(io.Discard, hijack.Reader)
		hijack.Close()
		insp, err := s.docker.ContainerExecInspect(ctx, exec.ID)
		if err != nil {
			c.JSON(http.StatusOK, modelReadyResp{Ready: false, Error: err.Error()})
			return
		}
		c.JSON(http.StatusOK, modelReadyResp{Ready: insp.ExitCode == 0})
		return
	}

	c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported runtime: " + req.Runtime})
}

func (s *server) handleCatalogTags(c *gin.Context) {
	ref := c.Query("ref")
	provider := c.DefaultQuery("provider", "dmr") // "dmr" / "ollama"
	ctx := c.Request.Context()

	if ref == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ref required"})
		return
	}

	var tags []catalogTag

	switch provider {
	case "ollama":
		repo := strings.TrimPrefix(ref, "ollama/")
		if i := strings.IndexByte(repo, ':'); i != -1 {
			repo = repo[:i]
		}
		ts, err := scrapeOllamaTags(ctx, repo)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "ollama: " + err.Error()})
			return
		}
		tags = ts

	case "dmr":
		fallthrough
	default:
		// Docker Hub repo tags.
		if !strings.Contains(ref, "/") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ref must be <namespace>/<repo>"})
			return
		}
		parts := strings.SplitN(ref, "/", 2)
		ns, repo := parts[0], parts[1]
		if i := strings.IndexByte(repo, ':'); i != -1 {
			repo = repo[:i]
		}
		var resp hubTagsResp
		u := fmt.Sprintf(
			"https://hub.docker.com/v2/repositories/%s/%s/tags/?page_size=100&ordering=-last_updated",
			ns, repo,
		)
		if err := httpGetJSON(ctx, u, &resp); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "docker hub: " + err.Error()})
			return
		}
		for _, r := range resp.Results {
			if r.TagStatus != "" && r.TagStatus != "active" {
				continue
			}
			tags = append(tags, catalogTag{
				Name:        r.Name,
				SizeBytes:   r.FullSize,
				LastUpdated: r.LastUpdated,
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{"ref": ref, "provider": provider, "tags": tags})
}
