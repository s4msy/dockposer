// Git-Backend: EIN Repo am Stacks-Wurzelordner (nicht pro Stack). Dockposer
// deployed nie AUS Git, es protokolliert NACH Git — Audit-Log und Undo gratis,
// ohne GitOps-Zwang.
//
// Tiefenregel: versioniert werden nur Dateien DIREKT in den Stack-Ordnern.
// Unterordner (Volumes, DB-Daten, Caches) bleiben komplett draußen — genau die
// Falle, in die man beim manuellen Anlegen sonst tappt.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const defaultGitignore = `# Von Dockposer angelegt.
#
# Regel: nur Dateien direkt in den Stack-Ordnern versionieren
# (compose.yaml, Caddyfile, …). Unterordner sind typischerweise Volumes
# und Datenbank-Verzeichnisse — die gehören nicht ins Repo.
/*/*/

# Secrets niemals versionieren
.env
.env.*
*.env

# Rollback-Pins von Dockposer sind Zustand, keine Konfiguration
.dockposer-rollback.yaml

# Soll ein Unterordner doch mitkommen, hier ausnehmen, z. B.:
# !/meinstack/config/
`

func gitAvailable() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func gitRun(ctx context.Context, args ...string) (string, error) {
	return run(ctx, stacksDir, 30*time.Second, "git", args...)
}

// ── GET /v1/git/status ──────────────────────────────────────────────────
func handleGitStatus(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{"git_installed": gitAvailable(), "is_repo": false}
	if !gitAvailable() {
		writeJSON(w, resp)
		return
	}
	if _, err := os.Stat(filepath.Join(stacksDir, ".git")); err != nil {
		writeJSON(w, resp)
		return
	}
	resp["is_repo"] = true
	if out, err := gitRun(r.Context(), "remote", "get-url", "origin"); err == nil {
		resp["remote"] = strings.TrimSpace(out)
	}
	if out, err := gitRun(r.Context(), "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		resp["branch"] = strings.TrimSpace(out)
	}
	if out, err := gitRun(r.Context(), "log", "-1", "--format=%h %ad %s", "--date=short"); err == nil {
		resp["last_commit"] = strings.TrimSpace(out)
	}
	if out, err := gitRun(r.Context(), "status", "--porcelain"); err == nil {
		resp["dirty_files"] = len(nonEmptyLines(out))
	}
	if data, err := os.ReadFile(filepath.Join(stacksDir, ".gitignore")); err == nil {
		resp["gitignore"] = string(data)
	}
	writeJSON(w, resp)
}

// ── POST /v1/git/init ───────────────────────────────────────────────────
// Legt das Repo am Stacks-Wurzelordner an (falls nicht vorhanden), schreibt die
// empfohlene .gitignore (nur wenn keine existiert!) und setzt das Remote.
func handleGitInit(w http.ResponseWriter, r *http.Request) {
	if !gitAvailable() {
		httpErr(w, 501, "git ist auf diesem Server nicht installiert")
		return
	}
	var req struct {
		Remote          string `json:"remote"`
		WriteGitignore  bool   `json:"write_gitignore"`
		OverwriteIgnore bool   `json:"overwrite_gitignore"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		httpErr(w, 400, "ungültiger Body")
		return
	}

	created := false
	if _, err := os.Stat(filepath.Join(stacksDir, ".git")); err != nil {
		if out, err := gitRun(r.Context(), "init", "-q", "-b", "main"); err != nil {
			httpErr(w, 500, "git init fehlgeschlagen: "+strings.TrimSpace(out))
			return
		}
		created = true
	}

	ignorePath := filepath.Join(stacksDir, ".gitignore")
	_, ignoreErr := os.Stat(ignorePath)
	wroteIgnore := false
	if req.WriteGitignore && (ignoreErr != nil || req.OverwriteIgnore) {
		if err := os.WriteFile(ignorePath, []byte(defaultGitignore), 0o644); err != nil {
			httpErr(w, 500, ".gitignore nicht schreibbar: "+err.Error())
			return
		}
		wroteIgnore = true
	}

	if req.Remote != "" {
		if _, err := gitRun(r.Context(), "remote", "get-url", "origin"); err == nil {
			gitRun(r.Context(), "remote", "set-url", "origin", req.Remote)
		} else {
			gitRun(r.Context(), "remote", "add", "origin", req.Remote)
		}
	}

	writeJSON(w, map[string]any{
		"repo_created":      created,
		"gitignore_written": wroteIgnore,
		"gitignore_existed": ignoreErr == nil,
	})
}

// gitCommitStack committet die Änderungen EINES Stacks im Wurzel-Repo.
// Rückgabe: (committed, pushed, error) — „nichts zu committen" ist kein Fehler.
func gitCommitStack(ctx context.Context, stackName, message string) (bool, error) {
	if !gitAvailable() {
		return false, errors.New("git ist auf diesem Server nicht installiert")
	}
	if _, err := os.Stat(filepath.Join(stacksDir, ".git")); err != nil {
		return false, errors.New("kein Git-Repo am Stacks-Pfad — in den Einstellungen einrichten")
	}
	// .gitignore anlegen, falls sie fehlt: sonst landen beim ersten Commit
	// womöglich komplette Volumes im Repo.
	ignorePath := filepath.Join(stacksDir, ".gitignore")
	if _, err := os.Stat(ignorePath); err != nil {
		os.WriteFile(ignorePath, []byte(defaultGitignore), 0o644)
		gitRun(ctx, "add", "--", ".gitignore")
	}

	if out, err := gitRun(ctx, "add", "-A", "--", stackName); err != nil {
		return false, fmt.Errorf("git add fehlgeschlagen: %s", strings.TrimSpace(out))
	}
	out, err := gitRun(ctx,
		"-c", "user.name=Dockposer", "-c", "user.email=dockposer@localhost",
		"commit", "-m", message, "--", stackName)
	if err != nil {
		low := strings.ToLower(out)
		if strings.Contains(low, "nothing to commit") || strings.Contains(low, "nichts zu committen") ||
			strings.Contains(low, "no changes added") {
			return false, nil
		}
		return false, fmt.Errorf("git commit fehlgeschlagen: %s", strings.TrimSpace(out))
	}

	// Best-Effort-Push, asynchron — hakeliges Netz darf das Speichern nie blockieren.
	if remotes, err := gitRun(ctx, "remote"); err == nil && strings.Contains(remotes, "origin") {
		go func() {
			pushCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			if out, err := run(pushCtx, stacksDir, 45*time.Second, "git", "push", "origin", "HEAD"); err != nil {
				log.Printf("[git] Push fehlgeschlagen: %s", strings.TrimSpace(out))
			}
		}()
	}
	return true, nil
}
