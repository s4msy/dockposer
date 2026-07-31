// Bearbeitbare Konfigurationsdateien neben der compose.yaml.
//
// Welche Dateien bearbeitbar sind, bestimmt eine Allowlist pro Agent:
//
//	DOCKPOSER_EDITABLE_FILES=".env,Caddyfile,*.conf"
//
// Default: ".env". Einfache Globs (*) sind erlaubt.
//
// Bewusst eng: nur Dateien DIREKT im Stack-Ordner, keine Unterordner, keine
// Pfadanteile im Namen. Inhalte gehen nur auf ausdrückliche Anfrage über die
// Leitung, nie als Beifang im Stack-Listing.
package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var editablePatterns []string

func initEditableFiles() {
	raw := os.Getenv("DOCKPOSER_EDITABLE_FILES")
	if strings.TrimSpace(raw) == "" {
		raw = ".env"
	}
	editablePatterns = nil
	for _, part := range strings.Split(raw, ",") {
		p := strings.Trim(strings.TrimSpace(part), `"'`)
		// Pfadanteile sind nie erlaubt — die Allowlist gilt nur für Dateinamen
		if p == "" || strings.ContainsAny(p, `/\`) || strings.Contains(p, "..") {
			continue
		}
		editablePatterns = append(editablePatterns, p)
	}
}

func isEditable(name string) bool {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return false
	}
	for _, pattern := range editablePatterns {
		if ok, err := filepath.Match(pattern, name); err == nil && ok {
			return true
		}
	}
	return false
}

// Compose liest nur .env-artige Dateien — nur für die lohnt die Gegenprobe
// per `compose config`. Eine kaputte Caddyfile kann Compose nicht erkennen.
func affectsCompose(name string) bool {
	return name == ".env" || strings.HasSuffix(name, ".env")
}

// ── GET /v1/stacks/{name}/files ─────────────────────────────────────────
// Listet die laut Allowlist bearbeitbaren Dateien, die im Ordner existieren.
func handleFilesList(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	type fileInfo struct {
		Name    string `json:"name"`
		Size    int64  `json:"size"`
		Secrets bool   `json:"secrets"` // .env-artig → nie nach Git, restriktive Rechte
	}
	files := []fileInfo{}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !isEditable(e.Name()) {
				continue
			}
			size := int64(0)
			if st, err := e.Info(); err == nil {
				size = st.Size()
			}
			files = append(files, fileInfo{Name: e.Name(), Size: size, Secrets: affectsCompose(e.Name())})
		}
	}
	writeJSON(w, map[string]any{"files": files, "allowed": editablePatterns})
}

// ── GET /v1/stacks/{name}/file?name=X ───────────────────────────────────
func handleFileGet(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	if !isEditable(name) {
		httpErr(w, 403, "Datei nicht in der Allowlist (DOCKPOSER_EDITABLE_FILES)")
		return
	}
	content, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, map[string]any{"exists": false, "content": "", "name": name})
			return
		}
		httpErr(w, 500, "nicht lesbar: "+err.Error())
		return
	}
	writeJSON(w, map[string]any{"exists": true, "content": string(content), "name": name})
}

// ── PUT /v1/stacks/{name}/file?name=X ───────────────────────────────────
func handleFilePut(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	name := r.URL.Query().Get("name")
	if !isEditable(name) {
		httpErr(w, 403, "Datei nicht in der Allowlist (DOCKPOSER_EDITABLE_FILES)")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 512<<10))
	if err != nil {
		httpErr(w, 400, "Body nicht lesbar")
		return
	}
	path := filepath.Join(dir, name)

	// Alten Stand sichern, um bei fehlgeschlagener Gegenprobe zurückzurollen
	previous, readErr := os.ReadFile(path)
	existedBefore := readErr == nil

	perm := os.FileMode(0o644)
	if affectsCompose(name) {
		perm = 0o600 // Secrets restriktiv anlegen
	}
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm() // bestehende Rechte respektieren
	}

	tmp := filepath.Join(dir, "."+name+".dockposer-tmp")
	if err := os.WriteFile(tmp, body, perm); err != nil {
		httpErr(w, 500, "nicht schreibbar: "+err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		httpErr(w, 500, "nicht schreibbar: "+err.Error())
		return
	}

	if affectsCompose(name) {
		if out, err := run(r.Context(), dir, 15*time.Second, "docker", "compose", "config", "--quiet"); err != nil {
			if existedBefore {
				os.WriteFile(path, previous, perm)
			} else {
				os.Remove(path)
			}
			httpErr(w, 422, "compose kann die Datei nicht verarbeiten (Änderung verworfen): "+strings.TrimSpace(out))
			return
		}
	}
	writeJSON(w, map[string]any{"saved": true, "name": name})
}
