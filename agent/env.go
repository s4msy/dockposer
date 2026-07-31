// .env-Bearbeitung — bewusst als Opt-in-Feature und bewusst eng gefasst:
// Nur die Datei mit dem exakten Namen ".env" wird gelesen/geschrieben. Andere
// Schreibweisen (.env.local, prod.env, …) bleiben unangetastet, weil Compose sie
// nur mit explizitem env_file: lädt — sie automatisch mitzueditieren wäre geraten.
//
// Inhalte gehen nur auf ausdrückliche Anfrage über die Leitung (eigener Endpunkt),
// nie als Beifang im Stack-Listing.
package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const envFileName = ".env"

func handleEnvGet(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	path := filepath.Join(dir, envFileName)
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, map[string]any{"exists": false, "content": ""})
			return
		}
		httpErr(w, 500, "nicht lesbar: "+err.Error())
		return
	}
	writeJSON(w, map[string]any{"exists": true, "content": string(content)})
}

func handleEnvPut(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil {
		httpErr(w, 400, "Body nicht lesbar")
		return
	}
	path := filepath.Join(dir, envFileName)

	// Alten Stand sichern, damit wir bei kaputter Interpolation zurückrollen können
	previous, readErr := os.ReadFile(path)
	existedBefore := readErr == nil
	perm := os.FileMode(0o600) // Secrets: restriktiv anlegen
	if st, err := os.Stat(path); err == nil {
		perm = st.Mode().Perm()
	}

	tmp := filepath.Join(dir, ".env.dockposer-tmp")
	if err := os.WriteFile(tmp, body, perm); err != nil {
		httpErr(w, 500, "nicht schreibbar: "+err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		httpErr(w, 500, "nicht schreibbar: "+err.Error())
		return
	}

	// Gegenprobe: Compose muss die Datei noch verarbeiten können (Interpolation!)
	if out, err := run(r.Context(), dir, 15*time.Second, "docker", "compose", "config", "--quiet"); err != nil {
		if existedBefore {
			os.WriteFile(path, previous, perm) // alten Stand zurückschreiben
		} else {
			os.Remove(path) // es gab vorher keine .env — keine hinterlassen
		}
		httpErr(w, 422, "compose kann die .env nicht verarbeiten (Änderung verworfen): "+strings.TrimSpace(out))
		return
	}
	writeJSON(w, map[string]any{"saved": true, "hash": hashComposeFiles(dir)})
}
