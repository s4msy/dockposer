// Update-Logik: der Watchtower-Ersatz. Läuft im Agent, weil nur er lokal
// pull/up/ps machen kann — die *Entscheidung* (Policies, Alerts) trifft der Core.
//
// Ablauf: Digests snapshotten → pull → up -d → Stabilisierungsfenster beobachten
// → bei Misserfolg Rollback über .dockposer-rollback.yaml (pinnt alte Digests).
// Die Override-Datei liegt sichtbar im Stack-Ordner — kein verstecktes Magic.
package main

import (
	"context"
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

const rollbackFile = ".dockposer-rollback.yaml"

type serviceImage struct {
	Service string   `json:"service"`
	Image   string   `json:"image"`
	Digest  string   `json:"digest"`  // erster RepoDigest (repo@sha256:…) oder leer
	Digests []string `json:"digests"` // alle RepoDigests — ein Image kann mehrere tragen!
}

// ── GET /v1/stacks/{name}/images ────────────────────────────────────────
func handleStackImages(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	imgs, err := stackImages(r.Context(), dir)
	if err != nil {
		httpErr(w, 502, err.Error())
		return
	}
	writeJSON(w, imgs)
}

func stackImages(ctx context.Context, dir string) ([]serviceImage, error) {
	out, err := run(ctx, dir, 20*time.Second, "docker", "compose", "config", "--format", "json")
	if err != nil {
		return nil, fmt.Errorf("compose config fehlgeschlagen: %s", strings.TrimSpace(out))
	}
	var cfg struct {
		Services map[string]struct {
			Image string `json:"image"`
		} `json:"services"`
	}
	if err := json.Unmarshal([]byte(out), &cfg); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(cfg.Services))
	for name := range cfg.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	imgs := make([]serviceImage, 0, len(names))
	for _, name := range names {
		img := cfg.Services[name].Image
		if img == "" {
			continue // build-basierte Services haben kein Registry-Image
		}
		digests := imageDigests(ctx, img)
		first := ""
		if len(digests) > 0 {
			first = digests[0]
		}
		imgs = append(imgs, serviceImage{Service: name, Image: img, Digest: first, Digests: digests})
	}
	return imgs, nil
}

func imageDigests(ctx context.Context, image string) []string {
	out, err := run(ctx, "", 10*time.Second, "docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image)
	if err != nil {
		return nil
	}
	var digests []string
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &digests) != nil {
		return nil
	}
	return digests
}

// ── POST /v1/stacks/{name}/update?window=90 ─────────────────────────────
func handleUpdate(w http.ResponseWriter, r *http.Request) {
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

	window := 90
	if v, err := strconv.Atoi(r.URL.Query().Get("window")); err == nil && v >= 30 && v <= 600 {
		window = v
	}

	f, okF := w.(http.Flusher)
	if !okF {
		httpErr(w, 500, "Streaming nicht unterstützt")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	emit := func(line string) {
		fmt.Fprintf(w, "data: %s\n\n", line)
		f.Flush()
	}
	result := func(res string, extra map[string]any) {
		payload := map[string]any{"result": res}
		for k, v := range extra {
			payload[k] = v
		}
		b, _ := json.Marshal(payload)
		fmt.Fprintf(w, "event: result\ndata: %s\n\n", b)
		f.Flush()
	}

	// Bewusst NICHT an r.Context() gekoppelt: Ein Update, dessen `up -d` schon
	// gelaufen ist, muss zu Ende geführt werden — auch wenn der Zuhörer geht
	// (Handy sperrt, Core startet neu, Netzwechsel). Sonst bricht der Lauf mitten
	// im Stabilisierungsfenster ab und landet im Abbruchpfad, obwohl am Stack
	// nichts falsch ist. Das Timeout bleibt die einzige Reißleine.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Minute)
	defer cancel()

	// 1) Snapshot
	emit("── Update mit Auto-Rollback ──")
	emit("Snapshot der aktuellen Image-Digests …")
	oldImgs, err := stackImages(ctx, dir)
	if err != nil {
		emit(err.Error())
		result("failed", map[string]any{"stage": "snapshot", "reason": err.Error()})
		return
	}
	oldDigests := map[string]string{}
	pinnedCount := 0
	for _, img := range oldImgs {
		// Per Digest gepinnte Images kann `pull` nicht verändern — für diese
		// Services ist ein Update wie ein Rollback wirkungslos.
		pinned := strings.Contains(img.Image, "@sha256:")
		if pinned {
			pinnedCount++
		}
		switch {
		case img.Digest == "":
			emit("  " + img.Service + ": kein Digest (lokal gebaut?) — kein Rollback für diesen Service möglich")
		case pinned:
			oldDigests[img.Service] = img.Digest
			emit("  " + img.Service + ": " + shortDigest(img.Digest) + "  [per Digest gepinnt — unveränderlich]")
		default:
			oldDigests[img.Service] = img.Digest
			emit("  " + img.Service + ": " + shortDigest(img.Digest))
		}
	}
	if pinnedCount == len(oldImgs) && pinnedCount > 0 {
		emit("Alle Images sind per Digest gepinnt — ein Update kann hier nichts ändern.")
		result("success", map[string]any{"old_digests": oldDigests, "new_digests": oldDigests})
		return
	}

	// Zustand VOR dem Eingriff festhalten (siehe wasBrokenBefore)
	before := healthSnapshot(ctx, dir)
	for svc, row := range before {
		if wasBrokenBefore(before, svc) {
			emit(fmt.Sprintf("  Ausgangslage: %s ist %s/%s — bereits vor dem Update auffällig", svc, row.State, row.Health))
		}
	}

	// 2) Pull
	emit("docker compose pull …")
	if exit := runStream(ctx, dir, w, f, "pull"); exit != 0 {
		result("failed", map[string]any{"stage": "pull", "reason": "pull fehlgeschlagen"})
		return
	}

	// 3) Up
	emit("docker compose up -d …")
	if exit := runStream(ctx, dir, w, f, "up", "-d"); exit != 0 {
		emit("up fehlgeschlagen — Rollback …")
		doRollback(ctx, dir, w, f, oldDigests, before, emit, result, "up fehlgeschlagen")
		return
	}

	// 4) Stabilisierungsfenster
	emit(fmt.Sprintf("Stabilisierungsfenster: %d Sekunden …", window))
	if reason := stabilize(ctx, dir, window, before, emit); reason != "" {
		// Ein abgebrochener Kontext ist KEIN Befund über den Stack. Früher lief das
		// in doRollback: Die Pin-Datei wurde geschrieben, das Rollback-`up` scheiterte
		// am toten Kontext, und im Stack-Ordner blieb eine Datei liegen, die beim
		// nächsten `up -d` mit Pin ein Downgrade bewirkt hätte.
		if ctx.Err() != nil {
			emit("Beobachtung abgebrochen (Zeitlimit) — kein Rollback, Zustand nicht bewertet.")
			result("failed", map[string]any{
				"stage":       "stabilize",
				"reason":      "Beobachtung abgebrochen — Stack unverändert, kein Rollback ausgeführt",
				"old_digests": oldDigests,
			})
			return
		}
		emit("Instabil: " + reason + " — Rollback …")
		doRollback(ctx, dir, w, f, oldDigests, before, emit, result, reason)
		return
	}

	// 5) Erfolg
	newImgs, _ := stackImages(ctx, dir)
	newDigests := map[string]string{}
	for _, img := range newImgs {
		if img.Digest != "" {
			newDigests[img.Service] = img.Digest
		}
	}
	if _, err := os.Stat(filepath.Join(dir, rollbackFile)); err == nil {
		os.Remove(filepath.Join(dir, rollbackFile))
		emit("Alte Rollback-Pin-Datei entfernt (Update erfolgreich).")
	}
	emit("✓ Update erfolgreich, alle Container stabil.")
	result("success", map[string]any{"old_digests": oldDigests, "new_digests": newDigests})
}

// stabilize beobachtet den Stack für `window` Sekunden.
// Leerer Rückgabewert = stabil; sonst der Grund für den Rollback.
// healthSnapshot hält den Zustand VOR dem Update fest. Nur so lässt sich
// unterscheiden, ob ein Problem durch das Update entstanden ist oder schon
// vorher bestand — sonst rollt Dockposer wegen eines Containers zurück, den
// es gar nicht angefasst hat.
func healthSnapshot(ctx context.Context, dir string) map[string]psRow {
	snap := map[string]psRow{}
	rows, err := composePs(ctx, dir)
	if err != nil {
		return snap
	}
	for _, row := range rows {
		snap[row.Service] = row
	}
	return snap
}

// wasBrokenBefore: lief dieser Service schon vor dem Update nicht sauber?
func wasBrokenBefore(before map[string]psRow, service string) bool {
	prev, known := before[service]
	if !known {
		return false // Service ist neu — dann zählt sein Zustand
	}
	return prev.Health == "unhealthy" || prev.State == "exited" || prev.State == "dead" ||
		prev.State == "restarting" || prev.State == ""
}

func stabilize(ctx context.Context, dir string, window int, before map[string]psRow, emit func(string)) string {
	deadline := time.Now().Add(time.Duration(window) * time.Second)
	lastNote := time.Now()
	noted := map[string]bool{}
	for {
		if ctx.Err() != nil {
			return "abgebrochen"
		}
		rows, err := composePs(ctx, dir)
		if err != nil {
			return "compose ps fehlgeschlagen: " + err.Error()
		}
		for _, row := range rows {
			// Vorbelastete Services nicht dem Update anlasten — einmal erwähnen,
			// damit der Zustand im Protokoll sichtbar bleibt.
			if wasBrokenBefore(before, row.Service) {
				if !noted[row.Service] {
					noted[row.Service] = true
					emit(fmt.Sprintf("  Hinweis: %s war schon vor dem Update nicht gesund — wird nicht bewertet", row.Service))
				}
				continue
			}
			switch row.State {
			case "exited", "dead":
				return fmt.Sprintf("%s ist %s", row.Service, row.State)
			case "restarting":
				return row.Service + " steckt in Restart-Schleife"
			}
			if row.Health == "unhealthy" {
				return row.Service + ": Healthcheck unhealthy"
			}
		}
		if time.Now().After(deadline) {
			// "starting" heißt: Docker hat noch KEIN Urteil gefällt (start_period
			// läuft). Das als Fehlschlag zu werten und zurückzurollen war falsch —
			// Container wie der Nextcloud-AIO-Mastercontainer brauchen mehrere
			// Minuten. Ein Rollback aus Ungeduld richtet mehr Schaden an als er
			// verhindert; bleibt der Container dauerhaft krank, meldet das später
			// ohnehin die Alert-Pipeline.
			for _, row := range rows {
				if wasBrokenBefore(before, row.Service) {
					continue
				}
				if row.Health == "starting" {
					emit("  ⚠ " + row.Service + ": Healthcheck noch nicht abgeschlossen (start_period läuft) — " +
						"kein Rollback, Zustand nicht bestätigt")
				}
			}
			return "" // nichts kaputt → gilt als stabil
		}
		if time.Since(lastNote) >= 15*time.Second {
			emit(fmt.Sprintf("  … stabil (noch %ds)", int(time.Until(deadline).Seconds())))
			lastNote = time.Now()
		}
		select {
		case <-ctx.Done():
			return "abgebrochen"
		case <-time.After(5 * time.Second):
		}
	}
}

type psRow struct {
	Service string `json:"Service"`
	State   string `json:"State"`
	Health  string `json:"Health"`
}

func composePs(ctx context.Context, dir string) ([]psRow, error) {
	out, err := run(ctx, dir, 15*time.Second, "docker", "compose", "ps", "--all", "--format", "json")
	if err != nil {
		return nil, err
	}
	rows := []psRow{}
	trimmed := strings.TrimSpace(out)
	if strings.HasPrefix(trimmed, "[") {
		json.Unmarshal([]byte(trimmed), &rows)
		return rows, nil
	}
	for _, line := range nonEmptyLines(out) {
		var row psRow
		if json.Unmarshal([]byte(line), &row) == nil {
			rows = append(rows, row)
		}
	}
	return rows, nil
}

func doRollback(ctx context.Context, dir string, w http.ResponseWriter, f http.Flusher,
	oldDigests map[string]string, before map[string]psRow,
	emit func(string), result func(string, map[string]any), reason string) {
	if len(oldDigests) == 0 {
		emit("Kein Rollback möglich: keine alten Digests bekannt.")
		result("failed", map[string]any{"stage": "rollback", "reason": reason + " (kein Rollback möglich)"})
		return
	}
	var b strings.Builder
	b.WriteString("# Von Dockposer nach fehlgeschlagenem Update erzeugt.\n")
	b.WriteString("# Pinnt Images auf den letzten funktionierenden Stand.\n")
	b.WriteString("# Aufräumen: compose.yaml aktualisieren, diese Datei löschen, `up -d`.\n")
	b.WriteString("services:\n")
	for service, digest := range oldDigests {
		b.WriteString("  " + service + ":\n    image: " + digest + "\n")
	}
	pin := filepath.Join(dir, rollbackFile)
	if err := os.WriteFile(pin, []byte(b.String()), 0o644); err != nil {
		result("failed", map[string]any{"stage": "rollback", "reason": "Pin-Datei nicht schreibbar: " + err.Error()})
		return
	}
	emit("Starte auf gepinnten alten Digests neu …")
	cf := filepath.Base(composeFile(dir))
	exit := runStream(ctx, dir, w, f, "-f", cf, "-f", rollbackFile, "up", "-d")
	if exit != 0 {
		result("failed", map[string]any{"stage": "rollback", "reason": reason + " (Rollback-up fehlgeschlagen!)"})
		return
	}
	// Gegenprobe: Hat der Rollback das Problem tatsächlich behoben? Ohne diese
	// Prüfung meldet Dockposer "läuft wieder auf altem Stand", obwohl der Stack
	// womöglich unverändert kaputt ist — und die Ursache lag dann nicht am Update.
	emit("Prüfe, ob der Rollback geholfen hat …")
	if stillBroken := stabilize(ctx, dir, 30, before, emit); stillBroken != "" {
		if ctx.Err() != nil {
			// Abbruch ist kein Urteil: Das Rollback-`up` lief bereits, der Stack
			// läuft auf den alten Digests. Die Pin-Datei jetzt zu löschen, wäre
			// gelogen — sie beschreibt den tatsächlichen Zustand.
			emit("Gegenprobe abgebrochen — Pin bleibt bestehen, Zustand nicht bestätigt.")
			result("rolled_back", map[string]any{
				"reason":      reason + " (Gegenprobe abgebrochen — nicht bestätigt)",
				"old_digests": oldDigests,
			})
			return
		}
		emit("⚠ Auch nach dem Rollback instabil: " + stillBroken)
		emit("Die Ursache liegt damit nicht am Update — die Pin-Datei wurde entfernt.")
		os.Remove(filepath.Join(dir, rollbackFile)) // nichts pinnen, was nicht hilft
		result("failed", map[string]any{
			"stage":       "rollback",
			"reason":      stillBroken + " (bestand auch nach dem Rollback — nicht durch das Update verursacht)",
			"old_digests": oldDigests,
		})
		return
	}
	emit("✓ Rollback aktiv — Stack läuft wieder auf altem Stand.")
	result("rolled_back", map[string]any{"reason": reason, "old_digests": oldDigests})
}

// runStream führt `docker compose <args>` aus und streamt die Ausgabe in den
// laufenden SSE-Response. Rückgabe: Exit-Code.
func runStream(ctx context.Context, dir string, w http.ResponseWriter, f http.Flusher, args ...string) int {
	full := append([]string{"compose", "--progress", "plain"}, args...)
	cmd := exec.CommandContext(ctx, "docker", full...)
	cmd.Dir = dir
	sw := &sseWriter{w: w, f: f}
	cmd.Stdout = sw
	cmd.Stderr = sw
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		fmt.Fprintf(w, "data: agent error: %s\n\n", err)
		f.Flush()
		return -1
	}
	return 0
}

func shortDigest(d string) string {
	if i := strings.Index(d, "@sha256:"); i > -1 && len(d) > i+20 {
		return d[:i] + "@sha256:" + d[i+8:i+20] + "…"
	}
	return d
}

// handlePinDelete entfernt die Rollback-Pin-Datei. Bisher ging das nur per SSH —
// eine Datei, die Dockposer selbst anlegt, muss Dockposer auch wieder aufräumen
// können. Der Stack läuft dadurch unverändert weiter; erst ein `up -d` wendet
// die compose.yaml wieder ohne Pin an.
func handlePinDelete(w http.ResponseWriter, r *http.Request) {
	dir, ok := stackDir(w, r)
	if !ok {
		return
	}
	path := filepath.Join(dir, rollbackFile)
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, map[string]any{"removed": false, "reason": "keine Pin-Datei vorhanden"})
			return
		}
		httpErr(w, 500, "Pin-Datei nicht löschbar: "+err.Error())
		return
	}
	writeJSON(w, map[string]any{"removed": true})
}
