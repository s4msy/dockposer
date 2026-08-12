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

const version = "0.3.0"

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
	mux.HandleFunc("GET /v1/stacks/{name}/drift", handleDriftDebug)
	mux.HandleFunc("GET /v1/stacks/{name}/images", handleStackImages)
	mux.HandleFunc("POST /v1/stacks/{name}/update", handleUpdate)
	mux.HandleFunc("PUT /v1/stacks/{name}/compose", handleComposePut)
	mux.HandleFunc("GET /v1/stacks/{name}/files", handleFilesList)
	mux.HandleFunc("GET /v1/stacks/{name}/file", handleFileGet)
	mux.HandleFunc("PUT /v1/stacks/{name}/file", handleFilePut)
	mux.HandleFunc("DELETE /v1/stacks/{name}", handleStackDelete)
	mux.HandleFunc("GET /v1/git/status", handleGitStatus)
	mux.HandleFunc("POST /v1/git/init", handleGitInit)
	mux.HandleFunc("POST /v1/stacks/{name}/up", action("up", "-d"))
	mux.HandleFunc("POST /v1/stacks/{name}/down", action("down"))
	mux.HandleFunc("POST /v1/stacks/{name}/pull", action("pull"))
	mux.HandleFunc("POST /v1/stacks/{name}/restart", action("restart"))
	mux.HandleFunc("GET /v1/events", handleEvents)
	mux.HandleFunc("GET /v1/containers/{id}/logs", handleLogs)

	initEditableFiles()
	log.Printf("dockposer-agent v%s · stacks=%s · listen=%s · editierbar=%s",
		version, stacksDir, listen, strings.Join(editablePatterns, ","))
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
	Name              string   `json:"name"`
	Path              string   `json:"path"`
	ComposeHash       string   `json:"compose_hash"`
	State             string   `json:"state"`
	ServicesRunning   int      `json:"services_running"`
	ServicesTotal     int      `json:"services_total"`
	ServicesUnhealthy int      `json:"services_unhealthy"`
	Drift             bool     `json:"drift"`
	DriftServices     []string `json:"drift_services,omitempty"`
}

func handleStacks(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(stacksDir)
	if err != nil {
		httpErr(w, 500, "Stacks-Ordner nicht lesbar: "+err.Error())
		return
	}
	// EIN docker-ps-Aufruf für alle Stacks statt zwei compose-Aufrufe pro Stack.
	// Bei 40 Stacks spart das ~80 Prozessstarts pro Übersichts-Refresh.
	liveByDir, liveByProject := collectLiveContainers(r.Context())

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
		hash := hashComposeFiles(dir)
		info := stackInfo{Name: e.Name(), Path: dir, ComposeHash: hash, State: "unknown"}

		// Erwartete Service-Hashes (teuer) über den Datei-Hash cachen
		expected := serviceHashes(r.Context(), dir, hash)
		info.ServicesTotal = len(expected)

		l, ok := liveByDir[dir]
		if !ok {
			l, ok = liveByProject[projectNameFor(e.Name())]
		}
		if ok {
			info.ServicesRunning = l.running
			info.ServicesUnhealthy = l.unhealthy
			if l.running > info.ServicesTotal {
				info.ServicesTotal = l.running // Replicas o. Ä. — nie "5/4" anzeigen
			}
			info.DriftServices = driftingServices(expected, l.hashes, newestComposeMtime(dir), l.oldestCreated)
			info.Drift = len(info.DriftServices) > 0
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

type liveCounts struct {
	running, unhealthy int
	// Service-Name → config-hash der LAUFENDEN Container.
	hashes map[string]string
	// Älteste Container-Erstellung im Stack. Zusammen mit der Datei-Mtime das
	// entscheidende Signal: Nur wenn die Dateien NACH dem Start geändert wurden,
	// kann der laufende Stand überhaupt veraltet sein.
	oldestCreated time.Time
}

// collectLiveContainers gruppiert alle Compose-Container nach ihrem
// Arbeitsverzeichnis — das ist exakt der Stack-Ordner.
func collectLiveContainers(ctx context.Context) (byDir, byProject map[string]*liveCounts) {
	byDir = map[string]*liveCounts{}
	byProject = map[string]*liveCounts{}
	out, err := run(ctx, "", 20*time.Second, "docker", "ps",
		"--filter", "label=com.docker.compose.project",
		"--format", strings.Join([]string{
			`{{.Label "com.docker.compose.project.working_dir"}}`,
			`{{.Label "com.docker.compose.project"}}`,
			`{{.Label "com.docker.compose.service"}}`,
			`{{.Label "com.docker.compose.config-hash"}}`,
			`{{.State}}`,
			`{{.Status}}`,
			`{{.CreatedAt}}`,
		}, "\t"))
	if err != nil {
		return byDir, byProject
	}
	tally := func(m map[string]*liveCounts, key, service, cfgHash, state, status, created string) {
		if key == "" {
			return
		}
		entry, ok := m[key]
		if !ok {
			entry = &liveCounts{hashes: map[string]string{}}
			m[key] = entry
		}
		if state == "running" {
			entry.running++
			if service != "" && cfgHash != "" {
				entry.hashes[service] = cfgHash
			}
			if t := parseDockerTime(created); !t.IsZero() {
				if entry.oldestCreated.IsZero() || t.Before(entry.oldestCreated) {
					entry.oldestCreated = t
				}
			}
		}
		// docker ps liefert Health nur im Status-Text: "Up 2 hours (unhealthy)"
		if strings.Contains(status, "(unhealthy)") {
			entry.unhealthy++
		}
	}
	for _, line := range nonEmptyLines(out) {
		cols := strings.Split(line, "\t")
		if len(cols) < 7 {
			continue
		}
		workdir, project, service, cfgHash, state, status, created :=
			cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], cols[6]
		if workdir != "" {
			tally(byDir, filepath.Clean(workdir), service, cfgHash, state, status, created)
		}
		// Zuordnung ersatzweise über den Projektnamen, falls das working_dir-Label
		// fehlt (ältere Compose-Versionen setzen es nicht).
		tally(byProject, project, service, cfgHash, state, status, created)
	}
	return byDir, byProject
}

// Compose normalisiert Ordnernamen zu Projektnamen: klein, nur [a-z0-9_-]
func projectNameFor(dirName string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(dirName) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Erwartete Service-Hashes je Datei-Hash zwischenspeichern — `compose config`
// ist teuer, das Ergebnis ändert sich aber nur mit den Dateien.
var (
	serviceHashCache = map[string]map[string]string{}
	serviceHashMu    sync.Mutex
)

// serviceHashes liefert die von Compose erwarteten config-hashes je Service.
// `compose config --hash="*"` gibt Name und Hash in einem Aufruf — ersetzt damit
// das frühere `--services` (gleiche Anzahl Prozessstarts) und liefert zusätzlich
// die Vergleichswerte für die Drift-Erkennung. Cache-Schlüssel ist der Datei-Hash
// (inkl. .env), das Ergebnis ändert sich also nur bei echten Dateiänderungen.
func serviceHashes(ctx context.Context, dir, cacheKey string) map[string]string {
	if cacheKey != "" {
		serviceHashMu.Lock()
		cached, ok := serviceHashCache[cacheKey]
		serviceHashMu.Unlock()
		if ok {
			return cached
		}
	}
	result := map[string]string{}
	out, err := run(ctx, dir, 20*time.Second, "docker", "compose", "config", "--hash=*")
	if err == nil {
		for _, line := range nonEmptyLines(out) {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				result[parts[0]] = parts[len(parts)-1]
			}
		}
	}
	// Rückfall: Kennt die Compose-Version --hash nicht, bleibt wenigstens die
	// Service-Anzahl korrekt (leerer Hash ⇒ dieser Service wird beim
	// Drift-Vergleich übersprungen, statt fälschlich Drift zu melden).
	if len(result) == 0 {
		out, err := run(ctx, dir, 15*time.Second, "docker", "compose", "config", "--services")
		if err != nil {
			return result // ungültige compose-Datei — nichts erfinden
		}
		for _, name := range nonEmptyLines(out) {
			result[strings.TrimSpace(name)] = ""
		}
	}
	if cacheKey != "" && len(result) > 0 {
		serviceHashMu.Lock()
		if len(serviceHashCache) > 500 {
			serviceHashCache = map[string]map[string]string{} // Deckel gegen Wachstum
		}
		serviceHashCache[cacheKey] = result
		serviceHashMu.Unlock()
	}
	return result
}

// parseDockerTime liest das CreatedAt-Format von `docker ps`
// ("2026-08-01 12:34:56 +0200 CEST").
func parseDockerTime(v string) time.Time {
	v = strings.TrimSpace(v)
	for _, layout := range []string{"2006-01-02 15:04:05 -0700 MST", "2006-01-02 15:04:05 -0700", time.RFC3339} {
		if t, err := time.Parse(layout, v); err == nil {
			return t
		}
	}
	return time.Time{}
}

// newestComposeMtime: wann wurden die Stack-Dateien zuletzt geändert?
func newestComposeMtime(dir string) time.Time {
	var newest time.Time
	var files []string
	if cf := composeFile(dir); cf != "" {
		files = append(files, cf)
	}
	for _, pat := range []string{"compose.override.y*ml", "docker-compose.override.y*ml"} {
		if m, err := filepath.Glob(filepath.Join(dir, pat)); err == nil {
			files = append(files, m...)
		}
	}
	files = append(files, envLikeFiles(dir)...)
	for _, f := range files {
		if st, err := os.Stat(f); err == nil && st.ModTime().After(newest) {
			newest = st.ModTime()
		}
	}
	return newest
}

// envLikeFiles: .env und *.env direkt im Stack-Ordner. Viele Projekte binden
// eine eigene Datei per env_file: ein (Paperless z. B. docker-compose.env) —
// die verändert die aufgelöste Konfiguration genauso wie .env.
func envLikeFiles(dir string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		// Glob "*.env" trifft auch ".env" — sonst landet sie doppelt im Hash
		if !seen[p] && fileExists(p) {
			seen[p] = true
			out = append(out, p)
		}
	}
	add(filepath.Join(dir, ".env"))
	if m, err := filepath.Glob(filepath.Join(dir, "*.env")); err == nil {
		for _, p := range m {
			add(p)
		}
	}
	sort.Strings(out)
	return out
}

// driftingServices nennt die Services, die von den Dateien abweichen.
//
// ZWEI Bedingungen müssen zutreffen — das ist bewusst so:
//
//  1. Die Dateien wurden NACH dem Start der Container geändert. Nur dann kann
//     der laufende Stand überhaupt veraltet sein.
//  2. Der config-hash weicht ab.
//
// Warum nicht nur (2)? Der config-hash wird von der Compose-Version berechnet,
// die den Container gestartet hat. Nach einem Compose-Update unterscheiden sich
// die Hashes bei UNVERÄNDERTEN Dateien — das würde bei jedem lange laufenden
// Stack fälschlich Drift melden. Bedingung (1) schließt das aus, weil ein
// Compose-Update die Datei-Mtime nicht anfasst.
//
// Warum nicht nur (1)? Ein bloßes `touch` oder ein Kommentar-Edit würde sonst
// Drift melden, obwohl die aufgelöste Konfiguration identisch ist.
func driftingServices(expected, actual map[string]string, fileMtime, containerCreated time.Time) []string {
	if len(expected) == 0 || len(actual) == 0 {
		return nil
	}
	// (1) Zeitfenster: Dateien müssen jünger sein als der älteste laufende Container.
	// Ohne verwertbare Zeitangaben lieber nichts melden.
	if fileMtime.IsZero() || containerCreated.IsZero() || !fileMtime.After(containerCreated) {
		return nil
	}
	// (2) Inhaltlicher Vergleich
	var drifting []string
	for service, actualHash := range actual {
		expectedHash, known := expected[service]
		if !known || expectedHash == "" || actualHash == "" {
			continue // Service nicht mehr definiert oder Label fehlt → nicht bewertbar
		}
		if expectedHash != actualHash {
			drifting = append(drifting, service)
		}
	}
	sort.Strings(drifting)
	return drifting
}

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

// handleDriftDebug legt alle Eingangsgrößen der Drift-Entscheidung offen.
// Rein diagnostisch — beantwortet die Frage "warum meldet der Agent (k)ein Drift?"
// ohne Rätselraten.
func handleDriftDebug(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	expected := serviceHashes(r.Context(), dir, "") // ohne Cache: immer frisch
	liveByDir, liveByProject := collectLiveContainers(r.Context())
	l, found := liveByDir[dir]
	matchedBy := "working_dir"
	if !found {
		l, found = liveByProject[projectNameFor(filepath.Base(dir))]
		matchedBy = "project_name"
	}
	if !found {
		matchedBy = "none"
		l = &liveCounts{hashes: map[string]string{}}
	}

	mtimes := map[string]string{}
	var files []string
	if cf := composeFile(dir); cf != "" {
		files = append(files, cf)
	}
	for _, pat := range []string{"compose.override.y*ml", "docker-compose.override.y*ml"} {
		if m, err := filepath.Glob(filepath.Join(dir, pat)); err == nil {
			files = append(files, m...)
		}
	}
	files = append(files, envLikeFiles(dir)...)
	for _, f := range files {
		if st, err := os.Stat(f); err == nil {
			mtimes[filepath.Base(f)] = st.ModTime().Format(time.RFC3339)
		}
	}

	fileMtime := newestComposeMtime(dir)
	drifting := driftingServices(expected, l.hashes, fileMtime, l.oldestCreated)

	reason := "kein Unterschied gefunden"
	switch {
	case len(expected) == 0:
		reason = "compose config lieferte keine Hashes (Datei ungültig?)"
	case len(l.hashes) == 0:
		reason = "keine laufenden Container mit config-hash-Label"
	case fileMtime.IsZero():
		reason = "Datei-Zeitstempel nicht lesbar"
	case l.oldestCreated.IsZero():
		reason = "Container-Startzeit nicht lesbar"
	case !fileMtime.After(l.oldestCreated):
		reason = "Dateien sind ÄLTER als die Container — Hash-Unterschiede stammen dann aus einem Compose-Update, nicht aus geänderten Dateien"
	case len(drifting) > 0:
		reason = "Dateien wurden nach dem Container-Start geändert UND Hashes weichen ab"
	}

	writeJSON(w, map[string]any{
		"agent_version":     version,
		"matched_by":        matchedBy,
		"file_mtimes":       mtimes,
		"newest_file_mtime": timeOrEmpty(fileMtime),
		"oldest_container":  timeOrEmpty(l.oldestCreated),
		"files_newer":       !fileMtime.IsZero() && !l.oldestCreated.IsZero() && fileMtime.After(l.oldestCreated),
		"expected_hashes":   expected,
		"actual_hashes":     l.hashes,
		"drift":             len(drifting) > 0,
		"drift_services":    drifting,
		"reason":            reason,
	})
}

func timeOrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
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
func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

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
	// .env und *.env fließen in die Interpolation ein und verändern damit die
	// aufgelöste Konfiguration — für Cache-Invalidierung entscheidend.
	files = append(files, envLikeFiles(dir)...)
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
