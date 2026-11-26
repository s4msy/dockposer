package main

// Pods bearbeiten, anlegen, löschen (Phase 2).
//
// Wie bei compose.yaml gilt: erst prüfen, dann schreiben. Geprüft wird mit dem
// Quadlet-Generator selbst (Dry-Run) gegen eine Kopie des GANZEN Pods-Pfads —
// sonst wären Verweise auf Netzwerke oder Volumes anderer Pods „unbekannt".
// Blockiert wird nur, was im bearbeiteten Pod fehlerhaft ist: Ein kaputter
// Nachbar soll das Speichern nicht verhindern.
//
// Nach dem Schreiben lädt der Agent systemd neu (daemon-reload), damit die
// erzeugten Units stimmen. Neu gestartet wird nichts — das entscheidet der
// Mensch, wie bei Stacks.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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

// Erlaubte Dateien im Pod-Ordner. .env wird nicht validiert (beeinflusst die
// erzeugten Units nicht), ist aber bearbeitbar — für EnvironmentFile=.
var podFileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(pod|container|network|volume|image|build|env)$`)

const maxPodFile = 256 * 1024

func isQuadletUnitFile(name string) bool {
	switch filepath.Ext(name) {
	case ".pod", ".container", ".network", ".volume", ".image", ".build":
		return true
	}
	return false
}

// ── Lesen ─────────────────────────────────────────────────────────────────

type podFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
	Secret  bool   `json:"secret"` // .env — Inhalt nur bewusst zeigen, nie ins Git
}

func handlePodFiles(w http.ResponseWriter, r *http.Request) {
	def, ok := podFromRequest(w, r)
	if !ok {
		return
	}
	files := []podFile{}
	for _, f := range def.Files {
		b, err := os.ReadFile(filepath.Join(def.Dir, f))
		if err != nil {
			continue
		}
		files = append(files, podFile{Name: f, Content: string(b), Secret: filepath.Ext(f) == ".env"})
	}
	writeJSON(w, map[string]any{"files": files, "path": def.Dir, "hash": hashPodFiles(def)})
}

// ── Prüfen ────────────────────────────────────────────────────────────────

type podValidation struct {
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// Fedora und Debian legen den Generator an dieselbe Stelle; der Fallback ruft
// Quadlet direkt auf.
func quadletGenerator() (string, []string) {
	for _, p := range []string{
		"/usr/lib/systemd/user-generators/podman-user-generator",
		"/usr/local/lib/systemd/user-generators/podman-user-generator",
	} {
		if _, err := os.Stat(p); err == nil {
			return p, []string{"--dryrun"}
		}
	}
	for _, p := range []string{"/usr/libexec/podman/quadlet", "/usr/lib/podman/quadlet"} {
		if _, err := os.Stat(p); err == nil {
			return p, []string{"-user", "-dryrun"}
		}
	}
	return "", nil
}

var generatorPrefix = regexp.MustCompile(`^quadlet-generator\[\d+\]:\s*`)

// validatePod prüft einen Pod-Ordner in seiner künftigen Form (files) im
// Zusammenhang aller anderen Pods. err nur bei technischem Fehlschlag.
func validatePod(ctx context.Context, name string, files map[string][]byte) (podValidation, error) {
	var res podValidation
	gen, args := quadletGenerator()
	if gen == "" {
		return res, fmt.Errorf("Quadlet-Generator nicht gefunden — ist Podman vollständig installiert?")
	}
	tmp, err := os.MkdirTemp("", "dockposer-quadlet-*")
	if err != nil {
		return res, err
	}
	defer os.RemoveAll(tmp)

	// Alle anderen Quadlet-Dateien mitnehmen (Unterordner und lose Dateien im
	// Pods-Pfad), damit Verweise zwischen Pods aufgelöst werden.
	entries, _ := os.ReadDir(podsDir)
	for _, e := range entries {
		src := filepath.Join(podsDir, e.Name())
		if !e.IsDir() {
			if isQuadletUnitFile(e.Name()) {
				copyFile(src, filepath.Join(tmp, e.Name()))
			}
			continue
		}
		if e.Name() == name || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub, _ := os.ReadDir(src)
		for _, f := range sub {
			if !f.IsDir() && isQuadletUnitFile(f.Name()) {
				os.MkdirAll(filepath.Join(tmp, e.Name()), 0o755)
				copyFile(filepath.Join(src, f.Name()), filepath.Join(tmp, e.Name(), f.Name()))
			}
		}
	}
	candidate := filepath.Join(tmp, name)
	os.MkdirAll(candidate, 0o755)
	for f, content := range files {
		if isQuadletUnitFile(f) {
			if err := os.WriteFile(filepath.Join(candidate, f), content, 0o644); err != nil {
				return res, err
			}
		}
	}

	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, gen, args...)
	cmd.Env = append(os.Environ(), "QUADLET_UNIT_DIRS="+tmp)
	cmd.Stdout = io.Discard
	var stderr strings.Builder
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if cctx.Err() != nil {
		return res, fmt.Errorf("Quadlet-Prüfung hat zu lange gedauert")
	}

	mine := candidate + string(filepath.Separator)
	var owners []*regexp.Regexp
	for f := range files {
		if isQuadletUnitFile(f) {
			owners = append(owners, regexp.MustCompile(`(^|[\s"'/])`+regexp.QuoteMeta(f)+`([\s"':,]|$)`))
		}
	}
	for _, line := range strings.Split(stderr.String(), "\n") {
		line = strings.TrimSpace(generatorPrefix.ReplaceAllString(line, ""))
		if line == "" || strings.HasPrefix(line, "Loading source unit file") {
			continue
		}
		// Zuordnung über den vollen Pfad oder den Dateinamen. Podman nennt je
		// nach Meldung mal das eine, mal das andere; Dateinamen sind über alle
		// Pods eindeutig (duplicateUnits), also reicht das.
		belongs := strings.Contains(line, mine)
		for _, re := range owners {
			if belongs {
				break
			}
			belongs = re.MatchString(line)
		}
		if !belongs {
			continue // Problem in einem anderen Pod — blockiert hier nicht
		}
		msg := strings.ReplaceAll(line, mine, "")
		msg = strings.ReplaceAll(msg, tmp+string(filepath.Separator), "")
		if strings.HasPrefix(msg, "Warning:") {
			res.Warnings = append(res.Warnings, strings.TrimSpace(strings.TrimPrefix(msg, "Warning:")))
		} else {
			res.Errors = append(res.Errors, msg)
		}
	}
	// Exit ≠ 0 ohne zuordenbare Zeile: Fehler bei einem Nachbarn — nicht unserer.
	_ = runErr
	return res, nil
}

// validatePodChange prüft die neue Fassung gegen die bisherige: Blockiert
// werden nur Fehler, die die Änderung NEU einführt. Schon vorhandene Fehler
// (etwa per SSH eingebaut, oder zwei kaputte Dateien) dürfen Schritt für
// Schritt repariert werden — sie kommen als Hinweis zurück.
func validatePodChange(ctx context.Context, name string, before, after map[string][]byte) (podValidation, error) {
	next, err := validatePod(ctx, name, after)
	if err != nil || len(next.Errors) == 0 || len(before) == 0 {
		return next, err
	}
	prev, err := validatePod(ctx, name, before)
	if err != nil {
		return next, nil
	}
	old := map[string]bool{}
	for _, e := range prev.Errors {
		old[e] = true
	}
	var fresh []string
	for _, e := range next.Errors {
		if old[e] {
			next.Warnings = append(next.Warnings, "schon vorher fehlerhaft: "+e)
		} else {
			fresh = append(fresh, e)
		}
	}
	next.Errors = fresh
	return next, nil
}

func copyFile(src, dst string) {
	if b, err := os.ReadFile(src); err == nil {
		os.WriteFile(dst, b, 0o644)
	}
}

// Dienstnamen dürfen über alle Pods hinweg nur einmal vorkommen — sonst gewinnt
// bei systemd stillschweigend eine Datei, und die andere ist wirkungslos.
func duplicateUnits(name string, files map[string][]byte) []string {
	taken := map[string]string{}
	for _, p := range listPods() {
		if p.Name == name {
			continue
		}
		for _, u := range p.Containers {
			taken[u] = p.Name
		}
		if p.PodUnit != "" {
			taken[p.PodUnit] = p.Name
		}
	}
	tmp, err := os.MkdirTemp("", "dockposer-names-*")
	if err != nil {
		return nil
	}
	defer os.RemoveAll(tmp)
	var dups []string
	clashed := map[string]bool{}
	// Quadlet liest jeden Dateinamen nur einmal (der erste Fund gewinnt) —
	// gleichnamige Dateien in zwei Pods würden sich gegenseitig verdecken.
	for _, p := range listPods() {
		if p.Name == name {
			continue
		}
		for _, f := range p.Files {
			if _, clash := files[f]; clash && isQuadletUnitFile(f) {
				clashed[f] = true
				dups = append(dups, fmt.Sprintf("%s gibt es schon im Pod „%s\" — Dateinamen müssen über alle Pods eindeutig sein", f, p.Name))
			}
		}
	}
	for f, content := range files {
		ext := filepath.Ext(f)
		if clashed[f] || (ext != ".container" && ext != ".pod") {
			continue
		}
		path := filepath.Join(tmp, f)
		os.WriteFile(path, content, 0o644)
		unit := quadletServiceName(path)
		if other, ok := taken[unit]; ok {
			dups = append(dups, fmt.Sprintf("%s erzeugt %s — den gibt es schon im Pod „%s\"", f, unit, other))
		}
	}
	sort.Strings(dups)
	return dups
}

// Eine Änderung pro Pod zur selben Zeit — und keine während Start/Stop.
func tryLockPod(w http.ResponseWriter, name string) (func(), bool) {
	mu, _ := podLocks.LoadOrStore(name, &sync.Mutex{})
	lock := mu.(*sync.Mutex)
	if !lock.TryLock() {
		httpErr(w, 409, "Auf diesem Pod läuft gerade eine Aktion — kurz warten")
		return nil, false
	}
	return lock.Unlock, true
}

// ── Schreiben ─────────────────────────────────────────────────────────────

// Atomar schreiben und Modus/Eigentümer einer bestehenden Datei übernehmen.
func writeAtomic(path string, content []byte, defaultPerm os.FileMode) error {
	perm := defaultPerm
	uid, gid := -1, -1
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			uid, gid = int(sys.Uid), int(sys.Gid)
		}
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".dockposer-tmp")
	if err := os.WriteFile(tmp, content, perm); err != nil {
		return err
	}
	os.Chmod(tmp, perm)
	if uid >= 0 {
		os.Chown(tmp, uid, gid)
	}
	return os.Rename(tmp, path)
}

func daemonReload(ctx context.Context) string {
	if out, err := run(ctx, "", 30*time.Second, "systemctl", "--user", "daemon-reload"); err != nil {
		return "systemctl --user daemon-reload fehlgeschlagen: " + firstLine(out)
	}
	return ""
}

func podRunning(ctx context.Context, def podDef) bool {
	all, err := podmanPs(ctx)
	if err != nil {
		return false
	}
	for _, c := range containersOf(def, all) {
		if c.State == "running" || c.State == "restarting" {
			return true
		}
	}
	return false
}

// Gemeinsamer Abschluss nach jeder Änderung: reload, Git, Antwort.
func finishPodChange(w http.ResponseWriter, r *http.Request, name string, val podValidation, defaultMsg string, extra map[string]any) {
	resp := map[string]any{"warnings": val.Warnings}
	for k, v := range extra {
		resp[k] = v
	}
	if msg := daemonReload(r.Context()); msg != "" {
		resp["reload_error"] = msg
	}
	if def, ok := readPod(name); ok {
		resp["hash"] = hashPodFiles(def)
		resp["restart_needed"] = podRunning(r.Context(), def)
	}
	if r.URL.Query().Get("git") == "1" {
		msg := r.URL.Query().Get("message")
		if msg == "" {
			msg = defaultMsg
		}
		committed, gitErr := gitCommitIn(r.Context(), podsDir, name, msg)
		resp["committed"] = committed
		if gitErr != nil {
			resp["git_error"] = gitErr.Error()
		}
	}
	writeJSON(w, resp)
}

func currentPodFiles(def podDef) map[string][]byte {
	files := map[string][]byte{}
	for _, f := range def.Files {
		if b, err := os.ReadFile(filepath.Join(def.Dir, f)); err == nil {
			files[f] = b
		}
	}
	return files
}

func rejectInvalid(w http.ResponseWriter, val podValidation, dups []string) bool {
	if len(val.Errors) == 0 && len(dups) == 0 {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(422)
	all := append(append([]string{}, val.Errors...), dups...)
	json.NewEncoder(w).Encode(map[string]any{
		"error":    "Quadlet-Dateien ungültig:\n" + strings.Join(all, "\n"),
		"errors":   all,
		"warnings": val.Warnings,
	})
	return true
}

// PUT /v1/pods/{name}/files/{file} — Body: neuer Inhalt
func handlePodFilePut(w http.ResponseWriter, r *http.Request) {
	def, ok := podFromRequest(w, r)
	if !ok {
		return
	}
	unlock, ok := tryLockPod(w, def.Name)
	if !ok {
		return
	}
	defer unlock()
	file := r.PathValue("file")
	if !podFileRe.MatchString(file) {
		httpErr(w, 400, "ungültiger Dateiname — erlaubt: .pod .container .network .volume .image .build .env")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPodFile+1))
	if err != nil || len(body) > maxPodFile {
		httpErr(w, 413, "Datei zu groß (max. 256 KB)")
		return
	}
	before := currentPodFiles(def)
	files := currentPodFiles(def)
	files[file] = body
	val, err := validatePodChange(r.Context(), def.Name, before, files)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	if rejectInvalid(w, val, duplicateUnits(def.Name, files)) {
		return
	}
	perm := os.FileMode(0o644)
	if filepath.Ext(file) == ".env" {
		perm = 0o600
	}
	if err := writeAtomic(filepath.Join(def.Dir, file), body, perm); err != nil {
		httpErr(w, 500, "nicht schreibbar: "+err.Error())
		return
	}
	finishPodChange(w, r, def.Name, val, fmt.Sprintf("%s/%s über Dockposer geändert", def.Name, file), nil)
}

// DELETE /v1/pods/{name}/files/{file}
func handlePodFileDelete(w http.ResponseWriter, r *http.Request) {
	def, ok := podFromRequest(w, r)
	if !ok {
		return
	}
	unlock, ok := tryLockPod(w, def.Name)
	if !ok {
		return
	}
	defer unlock()
	file := r.PathValue("file")
	if !podFileRe.MatchString(file) {
		httpErr(w, 400, "ungültiger Dateiname")
		return
	}
	files := currentPodFiles(def)
	if _, exists := files[file]; !exists {
		httpErr(w, 404, "Datei nicht gefunden")
		return
	}
	delete(files, file)
	units := 0
	for f := range files {
		if ext := filepath.Ext(f); ext == ".pod" || ext == ".container" {
			units++
		}
	}
	if units == 0 {
		httpErr(w, 409, "Das ist die letzte .pod/.container-Datei — dafür den ganzen Pod löschen")
		return
	}
	val, err := validatePodChange(r.Context(), def.Name, currentPodFiles(def), files)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	if rejectInvalid(w, val, nil) {
		return
	}
	if err := os.Remove(filepath.Join(def.Dir, file)); err != nil {
		httpErr(w, 500, "nicht löschbar: "+err.Error())
		return
	}
	finishPodChange(w, r, def.Name, val, fmt.Sprintf("%s/%s über Dockposer gelöscht", def.Name, file), nil)
}

// POST /v1/pods — {"name": "...", "files": {"x.container": "...", ...}}
func handlePodCreate(w http.ResponseWriter, r *http.Request) {
	if !podsEnabled {
		httpErr(w, 404, "Pods sind auf diesem Server nicht aktiv")
		return
	}
	var req struct {
		Name  string            `json:"name"`
		Files map[string]string `json:"files"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&req); err != nil {
		httpErr(w, 400, "ungültiger Body")
		return
	}
	if !nameRe.MatchString(req.Name) || strings.HasPrefix(req.Name, ".") {
		httpErr(w, 400, "ungültiger Name — erlaubt sind Buchstaben, Ziffern, . _ -")
		return
	}
	unlock, ok := tryLockPod(w, req.Name)
	if !ok {
		return
	}
	defer unlock()
	dir := filepath.Join(podsDir, req.Name)
	if _, err := os.Stat(dir); err == nil {
		httpErr(w, 409, "Es gibt schon einen Ordner „"+req.Name+"\" im Pods-Pfad")
		return
	}
	files := map[string][]byte{}
	units := 0
	for f, c := range req.Files {
		if !podFileRe.MatchString(f) {
			httpErr(w, 400, "ungültiger Dateiname: "+f)
			return
		}
		if len(c) > maxPodFile {
			httpErr(w, 413, f+" ist zu groß (max. 256 KB)")
			return
		}
		files[f] = []byte(c)
		if ext := filepath.Ext(f); ext == ".pod" || ext == ".container" {
			units++
		}
	}
	if units == 0 {
		httpErr(w, 400, "Ein Pod braucht mindestens eine .pod- oder .container-Datei")
		return
	}
	val, err := validatePod(r.Context(), req.Name, files)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	if rejectInvalid(w, val, duplicateUnits(req.Name, files)) {
		return
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		httpErr(w, 500, "Ordner nicht anlegbar: "+err.Error())
		return
	}
	for f, c := range files {
		perm := os.FileMode(0o644)
		if filepath.Ext(f) == ".env" {
			perm = 0o600
		}
		if err := writeAtomic(filepath.Join(dir, f), c, perm); err != nil {
			os.RemoveAll(dir)
			httpErr(w, 500, "nicht schreibbar: "+err.Error())
			return
		}
	}
	finishPodChange(w, r, req.Name, val, fmt.Sprintf("Pod %s über Dockposer angelegt", req.Name),
		map[string]any{"created": true, "name": req.Name})
}

// DELETE /v1/pods/{name} — nur gestoppt. Volumes und Daten bleiben (Podman
// legt sie außerhalb des Ordners an), wie bei Stacks.
func handlePodDelete(w http.ResponseWriter, r *http.Request) {
	def, ok := podFromRequest(w, r)
	if !ok {
		return
	}
	unlock, ok := tryLockPod(w, def.Name)
	if !ok {
		return
	}
	defer unlock()
	if podRunning(r.Context(), def) {
		httpErr(w, 409, "Pod läuft noch — erst stoppen, dann löschen")
		return
	}
	abs, err := filepath.Abs(def.Dir)
	if err != nil || !strings.HasPrefix(abs+string(filepath.Separator), podsDir+string(filepath.Separator)) || abs == podsDir {
		httpErr(w, 400, "ungültiger Pfad")
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		httpErr(w, 500, "Ordner nicht löschbar: "+err.Error())
		return
	}
	// Gestoppte Container des Pods räumt systemd beim Reload nicht weg; die
	// erzeugten Units verschwinden aber, damit nichts mehr startet.
	finishPodChange(w, r, def.Name, podValidation{}, fmt.Sprintf("Pod %s über Dockposer gelöscht", def.Name),
		map[string]any{"deleted": true, "name": def.Name})
}
