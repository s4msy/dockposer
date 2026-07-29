// Git-Backend: pro Stack ein lokales Repo. Dockposer deployed nie AUS Git,
// es protokolliert NACH Git — Audit-Log und Undo gratis, ohne GitOps-Zwang.
// Push zu einem Remote (z. B. Forgejo) ist Best-Effort: Wenn der User im
// Stack-Ordner ein origin-Remote samt Deploy-Key eingerichtet hat, wird
// gepusht — Credential-Verwaltung bleibt bewusst außerhalb von Dockposer.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// gitCommit committet den aktuellen Stand des Stack-Ordners.
// Rückgabe: (committed, error) — „nichts zu committen" ist kein Fehler.
func gitCommit(ctx context.Context, dir, message string) (bool, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return false, errors.New("git ist auf diesem Server nicht installiert")
	}

	// Repo bei Bedarf anlegen — mit .gitignore, damit Secrets nie im Repo landen
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		if out, err := run(ctx, dir, 10*time.Second, "git", "init", "-q"); err != nil {
			return false, fmt.Errorf("git init fehlgeschlagen: %s", strings.TrimSpace(out))
		}
		gi := filepath.Join(dir, ".gitignore")
		if _, err := os.Stat(gi); err != nil {
			os.WriteFile(gi, []byte("# Von Dockposer angelegt: Secrets gehören nie ins Repo\n.env\n.env.*\n*.env\n"), 0o644)
		}
	}

	if out, err := run(ctx, dir, 10*time.Second, "git", "add", "-A"); err != nil {
		return false, fmt.Errorf("git add fehlgeschlagen: %s", strings.TrimSpace(out))
	}
	out, err := run(ctx, dir, 15*time.Second,
		"git", "-c", "user.name=Dockposer", "-c", "user.email=dockposer@localhost",
		"commit", "-m", message)
	if err != nil {
		if strings.Contains(out, "nothing to commit") || strings.Contains(out, "nichts zu committen") {
			return false, nil
		}
		return false, fmt.Errorf("git commit fehlgeschlagen: %s", strings.TrimSpace(out))
	}

	// Best-Effort-Push, falls ein origin-Remote eingerichtet ist — asynchron,
	// damit ein hakeliges Netz das Speichern nie blockiert.
	if remotes, err := run(ctx, dir, 5*time.Second, "git", "remote"); err == nil && strings.Contains(remotes, "origin") {
		go func() {
			pushCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if out, err := run(pushCtx, dir, 30*time.Second, "git", "push", "origin", "HEAD"); err != nil {
				log.Printf("[git] Push fehlgeschlagen (%s): %s", filepath.Base(dir), strings.TrimSpace(out))
			}
		}()
	}
	return true, nil
}
