package main

// Pods: Podman-Anwendungen, die als Quadlet-Dateien von systemd betrieben werden.
//
// Ein Pod ist ein Unterordner im Quadlet-Pfad des Benutzers (Standard
// ~/.config/containers/systemd) — dort, wo Podman und systemd ihn ohnehin
// erwarten. Der Stacks-Ordner bleibt Docker vorbehalten. Die Unterscheidung
// ergibt sich aus dem Ort, nicht aus dem Dateiinhalt.
//
// Nur rootless und erst ab Podman 6.0. Ältere Versionen werden erkannt und
// abgelehnt, statt halb zu funktionieren.
//
// Gegenüber dem Core sehen Pods aus wie Stacks: gleiche Listen-, ps-, Stats-
// und Event-Formate. Dadurch greifen Statusanzeige, Alarmregeln und die
// Unterdrückung eigener Aktionen ohne Sonderwege.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const minPodmanMajor = 6

var (
	podsDir       string
	podsEnabled   bool
	podsProblem   string // warum Pods aus sind, obwohl ein Pfad gesetzt ist
	podmanVersion string
	podLocks      sync.Map
)

// dockerEnabled: Ohne Stacks-Ordner ist der Host ein reiner Podman-Host. Dann
// fragt der Agent Docker gar nicht erst — sonst meldete der Neustart-Schutz
// dauerhaft „Docker läuft nicht", und auf Fedora mit podman-docker würde der
// `docker`-Befehl stillschweigend Podman ansprechen.
func dockerEnabled() bool { return stacksDir != "" }

func initPods() {
	podsDir = os.Getenv("DOCKPOSER_PODS")
	if podsDir == "" {
		return
	}
	if abs, err := filepath.Abs(podsDir); err == nil {
		podsDir = abs
	}
	if os.Geteuid() == 0 {
		podsProblem = "Pods werden nur rootless unterstützt — der Agent läuft als root"
		return
	}
	out, err := run(context.Background(), "", 10*time.Second, "podman", "version", "--format", "{{.Client.Version}}")
	if err != nil {
		podsProblem = "podman nicht gefunden oder nicht ausführbar: " + strings.TrimSpace(out)
		return
	}
	podmanVersion = strings.TrimSpace(out)
	if major := leadingInt(podmanVersion); major < minPodmanMajor {
		podsProblem = fmt.Sprintf("Podman %s wird nicht unterstützt (ab %d.0)", podmanVersion, minPodmanMajor)
		return
	}
	if out, err := run(context.Background(), "", 10*time.Second, "systemctl", "--user", "show-environment"); err != nil {
		podsProblem = "keine systemd-Benutzersitzung erreichbar (loginctl enable-linger?): " + firstLine(out)
		return
	}
	if err := os.MkdirAll(podsDir, 0o755); err != nil {
		podsProblem = "Pods-Ordner nicht anlegbar: " + err.Error()
		return
	}
	podsEnabled = true
}

func leadingInt(s string) int {
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	n, _ := strconv.Atoi(s[:end])
	return n
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// ── Quadlet-Dateien lesen ─────────────────────────────────────────────────

type podDef struct {
	Name       string
	Dir        string
	PodUnit    string   // z. B. paperless-pod.service, leer ohne .pod-Datei
	Containers []string // Units der Container, z. B. web.service
	Files      []string
}

// Dienstname, den Quadlet aus einer Datei erzeugt: x.container → x.service,
// x.pod → x-pod.service. `ServiceName=` überschreibt beides.
func quadletServiceName(path string) string {
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if f, err := os.Open(path); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if v, ok := strings.CutPrefix(line, "ServiceName="); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSuffix(strings.TrimSpace(v), ".service") + ".service"
			}
		}
	}
	if ext == ".pod" {
		return stem + "-pod.service"
	}
	return stem + ".service"
}

func readPod(name string) (podDef, bool) {
	if !nameRe.MatchString(name) {
		return podDef{}, false
	}
	dir := filepath.Join(podsDir, name)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return podDef{}, false
	}
	def := podDef{Name: name, Dir: dir}
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		switch filepath.Ext(e.Name()) {
		case ".pod":
			def.PodUnit = quadletServiceName(path)
			def.Files = append(def.Files, e.Name())
		case ".container":
			def.Containers = append(def.Containers, quadletServiceName(path))
			def.Files = append(def.Files, e.Name())
		case ".network", ".volume", ".image", ".build", ".env":
			def.Files = append(def.Files, e.Name())
		}
	}
	if def.PodUnit == "" && len(def.Containers) == 0 {
		return podDef{}, false
	}
	sort.Strings(def.Containers)
	sort.Strings(def.Files)
	return def, true
}

func listPods() []podDef {
	entries, err := os.ReadDir(podsDir)
	if err != nil {
		return nil
	}
	var pods []podDef
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if def, ok := readPod(e.Name()); ok {
			pods = append(pods, def)
		}
	}
	return pods
}

// Unit → Pod-Name, für die Zuordnung von Events.
func unitIndex() map[string]string {
	idx := map[string]string{}
	for _, p := range listPods() {
		for _, u := range p.Containers {
			idx[u] = p.Name
		}
	}
	return idx
}

// Hash über alle Quadlet-Dateien — Gegenstück zum compose_hash der Stacks.
func hashPodFiles(def podDef) string {
	h := sha256.New()
	for _, f := range def.Files {
		b, err := os.ReadFile(filepath.Join(def.Dir, f))
		if err != nil {
			continue
		}
		fmt.Fprintf(h, "%s\x00%d\x00", f, len(b))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// ── Laufzeit-Zustand ──────────────────────────────────────────────────────

type podmanContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Labels  map[string]string `json:"Labels"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Image   string            `json:"Image"`
	IsInfra bool              `json:"IsInfra"`
}

// Vollständige JSON-Ausgabe statt Einzel-Templates: Seit Podman 6.0 liefert
// `{{json .Labels}}` key=value-Paare statt eines Objekts.
func podmanPs(ctx context.Context) ([]podmanContainer, error) {
	out, err := run(ctx, "", 15*time.Second, "podman", "ps", "--all", "--format", "json")
	if err != nil {
		return nil, fmt.Errorf("podman ps: %s", firstLine(out))
	}
	var rows []podmanContainer
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &rows); err != nil {
		return nil, fmt.Errorf("podman ps: unlesbare Ausgabe: %w", err)
	}
	return rows, nil
}

// Health steht bei Podman nur im Status-Text („Up 3 minutes (healthy)").
func healthFromStatus(status string) string {
	for _, h := range []string{"unhealthy", "healthy", "starting"} {
		if strings.Contains(status, "("+h+")") {
			return h
		}
	}
	return ""
}

func containersOf(def podDef, all []podmanContainer) []podmanContainer {
	units := map[string]bool{}
	for _, u := range def.Containers {
		units[u] = true
	}
	var out []podmanContainer
	for _, c := range all {
		// Infra-Container des Pods tragen das Unit-Label des Pods — kein Dienst
		if c.IsInfra || !units[c.Labels["PODMAN_SYSTEMD_UNIT"]] {
			continue
		}
		out = append(out, c)
	}
	return out
}

func handlePods(w http.ResponseWriter, r *http.Request) {
	result := []stackInfo{}
	if !podsEnabled {
		writeJSON(w, result)
		return
	}
	all, err := podmanPs(r.Context())
	if err != nil {
		httpErr(w, 502, err.Error())
		return
	}
	for _, def := range listPods() {
		info := stackInfo{Name: def.Name, Path: def.Dir, ComposeHash: hashPodFiles(def), ServicesTotal: len(def.Containers)}
		for _, c := range containersOf(def, all) {
			if c.State == "running" {
				info.ServicesRunning++
				if healthFromStatus(c.Status) == "unhealthy" {
					info.ServicesUnhealthy++
				}
			}
		}
		switch {
		case info.ServicesTotal == 0:
			info.State = "unknown"
		case info.ServicesRunning == 0:
			info.State = "stopped"
		case info.ServicesRunning < info.ServicesTotal:
			info.State = "partial"
		case info.ServicesUnhealthy > 0:
			info.State = "unhealthy"
		default:
			info.State = "running"
		}
		result = append(result, info)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	writeJSON(w, result)
}

func podFromRequest(w http.ResponseWriter, r *http.Request) (podDef, bool) {
	if !podsEnabled {
		msg := "Pods sind auf diesem Server nicht aktiv"
		if podsProblem != "" {
			msg += ": " + podsProblem
		}
		httpErr(w, 404, msg)
		return podDef{}, false
	}
	def, ok := readPod(r.PathValue("name"))
	if !ok {
		httpErr(w, 404, "Pod nicht gefunden")
		return podDef{}, false
	}
	return def, true
}

// Gleiches Format wie /v1/stacks/{name}/ps, damit die Detailseite beides kann.
func handlePodPs(w http.ResponseWriter, r *http.Request) {
	def, ok := podFromRequest(w, r)
	if !ok {
		return
	}
	all, err := podmanPs(r.Context())
	if err != nil {
		httpErr(w, 502, err.Error())
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
	for _, c := range containersOf(def, all) {
		name := c.ID
		if len(c.Names) > 0 {
			name = c.Names[0]
		}
		rows = append(rows, psRow{
			ID:      c.ID,
			Name:    name,
			Service: strings.TrimSuffix(c.Labels["PODMAN_SYSTEMD_UNIT"], ".service"),
			State:   c.State,
			Health:  healthFromStatus(c.Status),
			Status:  c.Status,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Service < rows[j].Service })
	writeJSON(w, rows)
}

// Start/Stop/Neustart über systemd. Vorher daemon-reload, damit Änderungen an
// den Quadlet-Dateien (auch per SSH) in die erzeugten Units übernommen werden.
func podAction(verb string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		def, ok := podFromRequest(w, r)
		if !ok {
			return
		}
		mu, _ := podLocks.LoadOrStore(def.Name, &sync.Mutex{})
		lock := mu.(*sync.Mutex)
		if !lock.TryLock() {
			httpErr(w, 409, "Auf diesem Pod läuft bereits eine Aktion")
			return
		}
		defer lock.Unlock()

		units := append([]string{}, def.Containers...)
		if def.PodUnit != "" {
			units = append([]string{def.PodUnit}, units...)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		script := "systemctl --user daemon-reload && systemctl --user " + verb + " " + strings.Join(quoteAll(units), " ") +
			" && echo 'systemctl --user " + verb + ": " + strings.Join(units, ", ") + " — ok'"
		cmd := exec.CommandContext(ctx, "sh", "-c", script)
		streamSSE(w, cmd)
	}
}

func quoteAll(xs []string) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = "'" + strings.ReplaceAll(x, "'", `'\''`) + "'"
	}
	return out
}

func handlePodLogs(w http.ResponseWriter, r *http.Request) {
	if !podsEnabled {
		httpErr(w, 404, "Pods sind auf diesem Server nicht aktiv")
		return
	}
	id := r.PathValue("id")
	if !nameRe.MatchString(id) {
		httpErr(w, 400, "ungültige Container-ID")
		return
	}
	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "200"
	}
	if _, err := strconv.Atoi(tail); err != nil {
		httpErr(w, 400, "ungültiger tail-Wert")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := exec.CommandContext(ctx, "podman", "logs", "--tail", tail, "--follow", id)
	streamSSE(w, cmd)
}

// ── Stats ─────────────────────────────────────────────────────────────────

type statRow struct {
	Name     string `json:"Name"`
	CPUPerc  string `json:"CPUPerc"`
	MemPerc  string `json:"MemPerc"`
	MemUsage string `json:"MemUsage"`
}

func podmanStats(ctx context.Context) []statRow {
	out, err := run(ctx, "", 20*time.Second, "podman", "stats", "--no-stream", "--format", "json")
	if err != nil {
		return nil
	}
	var raw []struct {
		Name       string `json:"name"`
		CPUPercent string `json:"cpu_percent"`
		MemPercent string `json:"mem_percent"`
		MemUsage   string `json:"mem_usage"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &raw) != nil {
		return nil
	}
	rows := make([]statRow, 0, len(raw))
	for _, s := range raw {
		rows = append(rows, statRow{Name: s.Name, CPUPerc: s.CPUPercent, MemPerc: s.MemPercent, MemUsage: s.MemUsage})
	}
	return rows
}

// ── Events ────────────────────────────────────────────────────────────────

type podmanEvent struct {
	Name         string            `json:"Name"`
	Status       string            `json:"Status"`
	Type         string            `json:"Type"`
	ExitCode     *int              `json:"ContainerExitCode"`
	HealthStatus string            `json:"health_status"`
	Attributes   map[string]string `json:"Attributes"`
}

// Übersetzt ein Podman-Event in das Docker-Format, das der Core versteht.
// Rückgabe: null bis zwei Zeilen (OOM wird bei Docker als eigenes Ereignis
// vor dem Exit gemeldet, bei Podman 6 als Attribut am Exit).
func normalizePodmanEvent(line string, units map[string]string) []string {
	var e podmanEvent
	if json.Unmarshal([]byte(line), &e) != nil || e.Type != "container" {
		return nil
	}
	unit := e.Attributes["PODMAN_SYSTEMD_UNIT"]
	if unit == "" || strings.HasSuffix(unit, "-pod.service") {
		return nil // nicht von Quadlet, oder Infra-Container
	}
	pod, ok := units[unit]
	if !ok {
		return nil // Quadlet außerhalb der Pods-Unterordner — nicht verwaltet
	}
	attrs := map[string]string{
		"name":                       e.Name,
		"com.docker.compose.project": pod, // gleicher Schlüssel wie bei Stacks
		"com.docker.compose.service": strings.TrimSuffix(unit, ".service"),
		"dockposer.runtime":          "podman",
	}
	emit := func(action string, extra map[string]string) string {
		a := map[string]string{}
		for k, v := range attrs {
			a[k] = v
		}
		for k, v := range extra {
			a[k] = v
		}
		b, _ := json.Marshal(map[string]any{"Action": action, "Type": "container", "Actor": map[string]any{"Attributes": a}})
		return string(b)
	}
	switch e.Status {
	case "died":
		code := 0
		if e.ExitCode != nil {
			code = *e.ExitCode
		}
		var out []string
		if strings.EqualFold(e.Attributes["OOMKilled"], "true") {
			out = append(out, emit("oom", nil))
		}
		return append(out, emit("die", map[string]string{"exitCode": strconv.Itoa(code)}))
	case "health_status":
		if e.HealthStatus == "" {
			return nil
		}
		return []string{emit("health_status: "+e.HealthStatus, nil)}
	case "start", "restart":
		return []string{emit(e.Status, nil)}
	}
	return nil
}

// Leitet Podman-Events normalisiert weiter, bis der Client geht. Podman hat
// keinen Daemon; endet der Befehl trotzdem, wird er neu gestartet.
func streamPodmanEvents(ctx context.Context, send func(string)) {
	for ctx.Err() == nil {
		cmd := exec.CommandContext(ctx, "podman", "events", "--format", "json",
			"--filter", "type=container",
			"--filter", "event=died",
			"--filter", "event=start",
			"--filter", "event=restart",
			"--filter", "event=health_status")
		stdout, err := cmd.StdoutPipe()
		if err == nil && cmd.Start() == nil {
			units, loaded := unitIndex(), time.Now()
			sc := bufio.NewScanner(stdout)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			for sc.Scan() {
				// Neue oder umbenannte Pods ohne Neustart des Agents erkennen
				if time.Since(loaded) > 30*time.Second {
					units, loaded = unitIndex(), time.Now()
				}
				for _, out := range normalizePodmanEvent(sc.Text(), units) {
					send("data: " + out + "\n\n")
				}
			}
			cmd.Wait()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}
