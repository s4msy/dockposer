// Dockposer Agent — dumme Durchreiche zu Docker-Socket und Stacks-Ordner.
// Kein Zustand außer der Config (ENV). Stirbt der Agent, läuft alles weiter.
//
// Konfiguration über Umgebungsvariablen:
//
//	DOCKPOSER_TOKEN   (Pflicht)  Bearer-Token, vom Core bei Registrierung generiert
//	DOCKPOSER_STACKS  (Pflicht)  Pfad zum Stacks-Ordner, z. B. /home/user/stacks
//	DOCKPOSER_LISTEN  (Default 127.0.0.1:8720)  TLS macht der Proxy davor
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "0.2.0"

var (
	token      string
	stacksDir  string
	stackLocks sync.Map // name → *sync.Mutex: eine Compose-Aktion pro Stack
	nameRe     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
)

var composeFileNames = []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"}

func main() {
	token = os.Getenv("DOCKPOSER_TOKEN")
	stacksDir = os.Getenv("DOCKPOSER_STACKS")
	listen := os.Getenv("DOCKPOSER_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:8720"
	}
	if token == "" || stacksDir == "" {
		log.Fatal("DOCKPOSER_TOKEN und DOCKPOSER_STACKS müssen gesetzt sein")
	}
	if abs, err := filepath.Abs(stacksDir); err == nil {
		stacksDir = abs
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", handleHealth)
	mux.HandleFunc("GET /v1/stacks", handleStacks)
	mux.HandleFunc("POST /v1/stacks", handleStackCreate)
	mux.HandleFunc("GET /v1/stats", handleStats)
	mux.HandleFunc("GET /v1/unmanaged", handleUnmanaged)
	mux.HandleFunc("GET /v1/stacks/{name}/compose", handleComposeGet)
	mux.HandleFunc("GET /v1/stacks/{name}/ps", handleStackPs)
	mux.HandleFunc("GET /v1/stacks/{name}/images", handleStackImages)
	mux.HandleFunc("POST /v1/stacks/{name}/update", handleUpdate)
	mux.HandleFunc("PUT /v1/stacks/{name}/compose", handleComposePut)
	mux.HandleFunc("GET /v1/stacks/{name}/env", handleEnvGet)
	mux.HandleFunc("PUT /v1/stacks/{name}/env", handleEnvPut)
	mux.HandleFunc("DELETE /v1/stacks/{name}", handleStackDelete)
	mux.HandleFunc("GET /v1/git/status", handleGitStatus)
	mux.HandleFunc("POST /v1/git/init", handleGitInit)
	mux.HandleFunc("POST /v1/stacks/{name}/up", action("up", "-d"))
	mux.HandleFunc("POST /v1/stacks/{name}/down", action("down"))
	mux.HandleFunc("POST /v1/stacks/{name}/pull", action("pull"))
	mux.HandleFunc("POST /v1/stacks/{name}/restart", action("restart"))
	mux.HandleFunc("GET /v1/events", handleEvents)
	mux.HandleFunc("GET /v1/containers/{id}/logs", handleLogs)

	log.Printf("dockposer-agent v%s · stacks=%s · listen=%s", version, stacksDir, listen)
	log.Fatal(http.ListenAndServe(listen, auth(mux)))
}

// ── Middleware ──────────────────────────────────────────────────────────

func auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Handler ─────────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	dockerVersion := "unknown"
	if out, err := run(r.Context(), "", 10*time.Second, "docker", "version", "--format", "{{.Server.Version}}"); err == nil {
		dockerVersion = strings.TrimSpace(out)
	}
	var st syscall.Statfs_t
	var free, total uint64
	if err := syscall.Statfs(stacksDir, &st); err == nil {
		free = st.Bavail * uint64(st.Bsize)
		total = st.Blocks * uint64(st.Bsize)
	}
	writeJSON(w, map[string]any{
		"version":        version,
		"docker_version": dockerVersion,
		"disk":           map[string]any{"stacks_path": stacksDir, "free_bytes": free, "total_bytes": total},
	})
}

type stackInfo struct {
	Name              string `json:"name"`
	Path              string `json:"path"`
	ComposeHash       string `json:"compose_hash"`
	State             string `json:"state"`
	ServicesRunning   int    `json:"services_running"`
	ServicesTotal     int    `json:"services_total"`
	ServicesUnhealthy int    `json:"services_unhealthy"`
	Drift             bool   `json:"drift"`
}

func handleStacks(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(stacksDir)
	if err != nil {
		httpErr(w, 500, "Stacks-Ordner nicht lesbar: "+err.Error())
		return
	}
	result := []stackInfo{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(stacksDir, e.Name())
		cf := composeFile(dir)
		if cf == "" {
			continue
		}
		info := stackInfo{Name: e.Name(), Path: dir, ComposeHash: hashComposeFiles(dir), State: "unknown"}
		fillState(r.Context(), dir, &info)
		result = append(result, info)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	writeJSON(w, result)
}

// fillState: Services zählen (compose config) und laufende Container zählen (compose ps).
func fillState(ctx context.Context, dir string, info *stackInfo) {
	if out, err := run(ctx, dir, 15*time.Second, "docker", "compose", "config", "--services"); err == nil {
		info.ServicesTotal = len(nonEmptyLines(out))
	}
	out, err := run(ctx, dir, 15*time.Second, "docker", "compose", "ps", "--format", "json")
	if err != nil {
		return
	}
	type psRow struct {
		State  string `json:"State"`
		Health string `json:"Health"`
	}
	rows := []psRow{}
	// compose gibt je nach Version ein JSON-Array oder Zeilen-JSON aus — beides abfangen
	trimmed := strings.TrimSpace(out)
	if strings.HasPrefix(trimmed, "[") {
		json.Unmarshal([]byte(trimmed), &rows)
	} else {
		for _, line := range nonEmptyLines(out) {
			var row psRow
			if json.Unmarshal([]byte(line), &row) == nil {
				rows = append(rows, row)
			}
		}
	}
	running, unhealthy := 0, 0
	for _, r := range rows {
		if r.State == "running" {
			running++
		}
		if r.Health == "unhealthy" {
			unhealthy++
		}
	}
	info.ServicesRunning = running
	info.ServicesUnhealthy = unhealthy
	switch {
	case info.ServicesTotal == 0:
		info.State = "unknown"
	case running == 0:
		info.State = "stopped"
	case running < info.ServicesTotal:
		info.State = "partial"
	case unhealthy > 0:
		// Alles läuft, aber ein Healthcheck schlägt an — nicht als "grün" verkaufen
		info.State = "unhealthy"
	default:
		info.State = "running"
	}
}

// handleStats: Einmal-Snapshot von docker stats für alle laufenden Container.
// Der Core pollt das; ein Dauerstream lohnt erst, wenn es jemand vermisst.
func handleStats(w http.ResponseWriter, r *http.Request) {
	out, err := run(r.Context(), "", 20*time.Second, "docker", "stats", "--no-stream", "--format", "json")
	if err != nil {
		httpErr(w, 502, "docker stats fehlgeschlagen: "+strings.TrimSpace(out))
		return
	}
	type statRow struct {
		Name     string `json:"Name"`
		CPUPerc  string `json:"CPUPerc"`
		MemPerc  string `json:"MemPerc"`
		MemUsage string `json:"MemUsage"`
	}
	rows := []statRow{}
	for _, line := range nonEmptyLines(out) {
		var row statRow
		if json.Unmarshal([]byte(line), &row) == nil {
			rows = append(rows, row)
		}
	}
	writeJSON(w, rows)
}

// handleStackCreate: neuen Stack-Ordner + compose-Datei anlegen.
// Validierung vor dem Anlegen — ungültiges YAML erzeugt keinen Ordner.
func handleStackCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		httpErr(w, 400, "ungültiger Body")
		return
	}
	if !nameRe.MatchString(req.Name) {
		httpErr(w, 400, "ungültiger Stack-Name (erlaubt: a-z, 0-9, . _ -)")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		httpErr(w, 400, "leere compose-Datei")
		return
	}
	dir := filepath.Join(stacksDir, req.Name)
	if _, err := os.Stat(dir); err == nil {
		httpErr(w, 409, "Stack existiert bereits")
		return
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	cf := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(cf, []byte(req.Content), 0o644); err != nil {
		os.RemoveAll(dir)
		httpErr(w, 500, err.Error())
		return
	}
	if out, err := run(r.Context(), dir, 15*time.Second, "docker", "compose", "config", "--quiet"); err != nil {
		os.RemoveAll(dir) // Validierung gescheitert → keinen Müll hinterlassen
		httpErr(w, 422, "compose.yaml ungültig: "+strings.TrimSpace(out))
		return
	}
	writeJSON(w, map[string]any{"name": req.Name, "hash": hashComposeFiles(dir)})
}

// handleStackDelete: Stack-Ordner entfernen. Voraussetzung: kein Container läuft.
// Volumes bleiben unangetastet — deren Löschung ist die gefährlichste Operation
// und bleibt der CLI vorbehalten. Der Core prüft „down" zusätzlich; hier ist die
// serverseitige Absicherung, damit kein laufender Stack unter den Füßen wegbricht.
func handleStackDelete(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	rows, err := composePs(r.Context(), dir)
	if err == nil {
		for _, row := range rows {
			if row.State == "running" || row.State == "restarting" {
				httpErr(w, 409, "Stack läuft noch — erst \"down\", dann löschen")
				return
			}
		}
	}
	// Sicherheitshalber down (räumt gestoppte Container/Netzwerke des Projekts weg),
	// Volumes bleiben (kein -v). Ein Fehler hier ist unkritisch — der Ordner geht trotzdem.
	run(r.Context(), dir, 60*time.Second, "docker", "compose", "down")

	// Ziel muss innerhalb des Stacks-Pfads liegen — Schutz vor Symlink-Tricks
	abs, absErr := filepath.Abs(dir)
	if absErr != nil || !strings.HasPrefix(abs+string(filepath.Separator), stacksDir+string(filepath.Separator)) {
		httpErr(w, 400, "ungültiger Pfad")
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		if os.IsPermission(err) {
			httpErr(w, 500, "Ordner nicht löschbar (Rechte): Teile gehören vermutlich root. "+
				"Der Agent-User braucht Schreibrechte im Stack-Ordner. Details: "+err.Error())
			return
		}
		httpErr(w, 500, "Ordner nicht löschbar: "+err.Error())
		return
	}
	writeJSON(w, map[string]any{"deleted": true, "name": r.PathValue("name")})
}

// handleUnmanaged: laufende Container, die NICHT zu einem Stack im Stacks-Pfad
// gehören. Rein informativ — Dockposer verwaltet sie nicht, macht sie nur sichtbar.
// Zwei Sorten: compose-Stacks außerhalb des Pfads, und einzeln gestartete Container.
func handleUnmanaged(w http.ResponseWriter, r *http.Request) {
	out, err := run(r.Context(), "", 20*time.Second, "docker", "ps",
		"--filter", "status=running",
		"--format", "{{.Names}}\t{{.Image}}\t{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.project.working_dir\"}}")
	if err != nil {
		httpErr(w, 502, "docker ps fehlgeschlagen: "+strings.TrimSpace(out))
		return
	}

	// Bekannte Stack-Ordner einsammeln (Vergleich über den absoluten Pfad)
	known := map[string]bool{}
	if entries, err := os.ReadDir(stacksDir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				known[filepath.Join(stacksDir, e.Name())] = true
			}
		}
	}

	type unmanaged struct {
		Name       string `json:"name"`
		Image      string `json:"image"`
		Project    string `json:"project,omitempty"`
		WorkingDir string `json:"working_dir,omitempty"`
		Kind       string `json:"kind"` // "external_stack" | "standalone"
	}
	items := []unmanaged{}
	for _, line := range nonEmptyLines(out) {
		cols := strings.Split(line, "\t")
		if len(cols) < 4 {
			continue
		}
		name, image, project, workdir := cols[0], cols[1], cols[2], cols[3]
		if project == "" {
			// Kein compose-Label → einzeln per docker run gestartet
			items = append(items, unmanaged{Name: name, Image: image, Kind: "standalone"})
			continue
		}
		if workdir != "" && known[filepath.Clean(workdir)] {
			continue // gehört zu einem verwalteten Stack
		}
		items = append(items, unmanaged{
			Name: name, Image: image, Project: project, WorkingDir: workdir, Kind: "external_stack",
		})
	}
	writeJSON(w, items)
}

func handleComposeGet(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	cf := composeFile(dir)
	content, err := os.ReadFile(cf)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	// .env-Dateinamen melden, nie Inhalte über die Leitung
	envFiles := []string{}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && (e.Name() == ".env" || strings.HasSuffix(e.Name(), ".env")) {
				envFiles = append(envFiles, e.Name())
			}
		}
	}
	_, pinErr := os.Stat(filepath.Join(dir, rollbackFile))
	writeJSON(w, map[string]any{
		"file":      filepath.Base(cf),
		"content":   string(content),
		"hash":      hashComposeFiles(dir),
		"env_files": envFiles,
		"pinned":    pinErr == nil, // .dockposer-rollback.yaml vorhanden → läuft auf altem Stand
	})
}

// handleStackPs: Container des Stacks — Basis für Service-Liste und Log-Auswahl.
func handleStackPs(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	out, err := run(r.Context(), dir, 15*time.Second, "docker", "compose", "ps", "--all", "--format", "json")
	if err != nil {
		httpErr(w, 502, "compose ps fehlgeschlagen: "+strings.TrimSpace(out))
		return
	}
	type psRow struct {
		ID      string `json:"ID"`
		Name    string `json:"Name"`
		Service string `json:"Service"`
		State   string `json:"State"`
		Health  string `json:"Health"`
		Status  string `json:"Status"`
	}
	rows := []psRow{}
	trimmed := strings.TrimSpace(out)
	if strings.HasPrefix(trimmed, "[") {
		json.Unmarshal([]byte(trimmed), &rows)
	} else {
		for _, line := range nonEmptyLines(out) {
			var row psRow
			if json.Unmarshal([]byte(line), &row) == nil {
				rows = append(rows, row)
			}
		}
	}
	writeJSON(w, rows)
}

func handleComposePut(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB reicht für jede compose.yaml
	if err != nil || len(body) == 0 {
		httpErr(w, 400, "leerer Body")
		return
	}
	// Validierung vor dem Schreiben: compose config gegen die neue Datei
	tmp, err := os.CreateTemp(dir, ".dockposer-validate-*.yaml")
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	tmp.Write(body)
	tmp.Close()
	if out, err := run(r.Context(), dir, 15*time.Second, "docker", "compose", "-f", tmpName, "config", "--quiet"); err != nil {
		httpErr(w, 422, "compose.yaml ungültig: "+strings.TrimSpace(out))
		return
	}
	// Atomar: tmp + rename auf die echte Datei
	cf := composeFile(dir)
	if err := os.Rename(tmpName, cf); err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	resp := map[string]any{"hash": hashComposeFiles(dir)}
	if r.URL.Query().Get("git") == "1" {
		msg := r.URL.Query().Get("message")
		if msg == "" {
			msg = "compose über Dockposer geändert"
		}
		committed, gitErr := gitCommitStack(r.Context(), r.PathValue("name"), msg)
		resp["committed"] = committed
		if gitErr != nil {
			resp["git_error"] = gitErr.Error()
		}
	}
	writeJSON(w, resp)
}

// action: compose-Kommando ausführen, Ausgabe als SSE streamen.
func action(args ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dir, ok := stackDir(w, r)
		if !ok {
			return
		}
		name := r.PathValue("name")
		mu, _ := stackLocks.LoadOrStore(name, &sync.Mutex{})
		lock := mu.(*sync.Mutex)
		if !lock.TryLock() {
			httpErr(w, 409, "Auf diesem Stack läuft bereits eine Aktion")
			return
		}
		defer lock.Unlock()

		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "docker", append([]string{"compose"}, args...)...)
		cmd.Dir = dir
		streamSSE(w, cmd)
	}
}

// handleEvents: gefilterte docker events als Endlos-SSE-Stream — die Quelle
// der Alert-Pipeline im Core. Kein Timeout; Client-Disconnect beendet den Prozess.
func handleEvents(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		httpErr(w, 500, "Streaming nicht unterstützt")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)

	cmd := exec.CommandContext(r.Context(), "docker", "events",
		"--format", "{{json .}}",
		"--filter", "type=container",
		"--filter", "event=die",
		"--filter", "event=oom",
		"--filter", "event=health_status",
		"--filter", "event=restart",
		"--filter", "event=start")

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err)
		f.Flush()
		return
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", err)
		f.Flush()
		return
	}

	// Event-Zeilen über einen Channel einsammeln, damit der Heartbeat-Ticker
	// unabhängig davon feuern kann, ob gerade Docker-Events fließen.
	lines := make(chan string, 16)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			cmd.Process.Kill()
			return
		case line, ok := <-lines:
			if !ok {
				cmd.Wait()
				fmt.Fprintf(w, "event: exit\ndata: 0\n\n")
				f.Flush()
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", line)
			f.Flush()
		case <-heartbeat.C:
			// SSE-Kommentarzeile: hält die Verbindung offen, ist kein Event
			fmt.Fprint(w, ": heartbeat\n\n")
			f.Flush()
		}
	}
}

func handleLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !nameRe.MatchString(id) {
		httpErr(w, 400, "ungültige Container-ID")
		return
	}
	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "200"
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "logs", "--tail", tail, "--follow", id)
	streamSSE(w, cmd)
}

// ── SSE ─────────────────────────────────────────────────────────────────

type sseWriter struct {
	w  http.ResponseWriter
	f  http.Flusher
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *sseWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.b.Write(p)
	for {
		line, err := s.b.ReadString('\n')
		if err != nil {
			s.b.WriteString(line) // unvollständige Zeile zurücklegen
			break
		}
		fmt.Fprintf(s.w, "data: %s\n\n", strings.TrimRight(line, "\r\n"))
	}
	s.f.Flush()
	return len(p), nil
}

func streamSSE(w http.ResponseWriter, cmd *exec.Cmd) {
	f, ok := w.(http.Flusher)
	if !ok {
		httpErr(w, 500, "Streaming nicht unterstützt")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	sw := &sseWriter{w: w, f: f}
	cmd.Stdout = sw
	cmd.Stderr = sw
	err := cmd.Run()
	exit := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exit = ee.ExitCode()
		} else {
			exit = -1
			fmt.Fprintf(w, "data: agent error: %s\n\n", err)
		}
	}
	fmt.Fprintf(w, "event: exit\ndata: %d\n\n", exit)
	f.Flush()
}

// ── Helpers ─────────────────────────────────────────────────────────────

func stackDir(w http.ResponseWriter, r *http.Request) (string, bool) {
	name := r.PathValue("name")
	if !nameRe.MatchString(name) { // kein Path-Traversal
		httpErr(w, 400, "ungültiger Stack-Name")
		return "", false
	}
	dir := filepath.Join(stacksDir, name)
	if composeFile(dir) == "" {
		httpErr(w, 404, "Stack nicht gefunden")
		return "", false
	}
	return dir, true
}

func composeFile(dir string) string {
	for _, n := range composeFileNames {
		p := filepath.Join(dir, n)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// Hash über compose.yaml + Override-Dateien (sortiert, dateinamen-präfixiert)
func hashComposeFiles(dir string) string {
	var files []string
	if cf := composeFile(dir); cf != "" {
		files = append(files, cf)
	}
	for _, pat := range []string{"compose.override.y*ml", "docker-compose.override.y*ml"} {
		if m, err := filepath.Glob(filepath.Join(dir, pat)); err == nil {
			files = append(files, m...)
		}
	}
	sort.Strings(files)
	h := sha256.New()
	for _, f := range files {
		if b, err := os.ReadFile(f); err == nil {
			h.Write([]byte(filepath.Base(f)))
			h.Write([]byte{0})
			h.Write(b)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func run(ctx context.Context, dir string, timeout time.Duration, name string, args ...string) (string, error) {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(c, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

func nonEmptyLines(s string) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(s))
	for sc.Scan() {
		if t := strings.TrimSpace(sc.Text()); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
