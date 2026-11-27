package main

// Pods aktualisieren (Phase 3).
//
// Prüfen macht der Core wie bei Stacks (Registry-Digest gegen lokalen Digest,
// mit hinterlegten Zugangsdaten und Release-Infos) — der Agent liefert dafür
// nur die laufenden Images. Ausgeführt wird mit `podman auto-update`, gefiltert
// auf die Units dieses Pods: Podman zieht das neue Image, startet die Unit neu
// und rollt selbst zurück, wenn der Neustart scheitert. Danach beobachtet
// Dockposer wie bei Stacks ein Stabilisierungsfenster; stürzt in dieser Zeit
// etwas ab, wird das alte Image zurückgetaggt und neu gestartet.
//
// Voraussetzung je Container: AutoUpdate=registry (oder local) in der
// .container-Datei. Ohne das fasst `podman auto-update` den Container nicht an.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const autoUpdateLabel = "io.containers.autoupdate"

type podImage struct {
	serviceImage
	// Wert von AutoUpdate= (registry, local) — leer = Podman aktualisiert nicht
	AutoUpdate string `json:"auto_update"`
}

// RepoDigests über die vollständige JSON-Ausgabe — Einzel-Templates haben sich
// in Podman 6 schon einmal im Format geändert.
func podmanImageDigests(ctx context.Context, image string) []string {
	out, err := run(ctx, "", 15*time.Second, "podman", "image", "inspect", image)
	if err != nil {
		return nil
	}
	var info []struct {
		RepoDigests []string `json:"RepoDigests"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &info) != nil || len(info) == 0 {
		return nil
	}
	return info[0].RepoDigests
}

func serviceOf(c podmanContainer) string {
	return strings.TrimSuffix(c.Labels["PODMAN_SYSTEMD_UNIT"], ".service")
}

func podImages(ctx context.Context, def podDef) ([]podImage, error) {
	all, err := podmanPs(ctx)
	if err != nil {
		return nil, err
	}
	cs := containersOf(def, all)
	sort.Slice(cs, func(i, j int) bool { return serviceOf(cs[i]) < serviceOf(cs[j]) })
	imgs := []podImage{}
	seen := map[string]bool{}
	for _, c := range cs {
		svc := serviceOf(c)
		if seen[svc] || c.Image == "" {
			continue
		}
		seen[svc] = true
		// Das laufende Image zählt (ImageID), nicht was der Tag lokal gerade meint
		ref := c.ImageID
		if ref == "" {
			ref = c.Image
		}
		digests := podmanImageDigests(ctx, ref)
		first := ""
		if len(digests) > 0 {
			first = digests[0]
		}
		imgs = append(imgs, podImage{
			serviceImage: serviceImage{Service: svc, Image: c.Image, Digest: first, Digests: digests},
			AutoUpdate:   c.Labels[autoUpdateLabel],
		})
	}
	return imgs, nil
}

// GET /v1/pods/{name}/images — leer, solange der Pod nie gestartet wurde
func handlePodImages(w http.ResponseWriter, r *http.Request) {
	def, ok := podFromRequest(w, r)
	if !ok {
		return
	}
	imgs, err := podImages(r.Context(), def)
	if err != nil {
		httpErr(w, 502, err.Error())
		return
	}
	writeJSON(w, imgs)
}

func podPsRows(ctx context.Context, def podDef) ([]psRow, error) {
	all, err := podmanPs(ctx)
	if err != nil {
		return nil, err
	}
	rows := []psRow{}
	for _, c := range containersOf(def, all) {
		rows = append(rows, psRow{Service: serviceOf(c), State: c.State, Health: healthFromStatus(c.Status)})
	}
	return rows, nil
}

// Eine Zeile aus `podman auto-update --format json`. Die Doku nennt nur die
// Template-Namen; ältere Versionen schrieben SystemdUnit statt Unit.
type autoUpdateReport struct {
	Unit          string `json:"Unit"`
	SystemdUnit   string `json:"SystemdUnit"`
	Container     string `json:"Container"`
	ContainerName string `json:"ContainerName"`
	Image         string `json:"Image"`
	Policy        string `json:"Policy"`
	Updated       string `json:"Updated"`
}

func (r autoUpdateReport) unit() string {
	if r.Unit != "" {
		return r.Unit
	}
	return r.SystemdUnit
}

// POST /v1/pods/{name}/update?window=90
func handlePodUpdate(w http.ResponseWriter, r *http.Request) {
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
		for _, l := range strings.Split(strings.TrimRight(line, "\n"), "\n") {
			fmt.Fprintf(w, "data: %s\n\n", l)
		}
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
	// Wie bei Stacks nicht an den Zuhörer gekoppelt — ein begonnenes Update
	// wird zu Ende geführt, auch wenn der Browser geht.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 30*time.Minute)
	defer cancel()

	emit("── Update über podman auto-update ──")
	all, err := podmanPs(ctx)
	if err != nil {
		emit(err.Error())
		result("failed", map[string]any{"stage": "snapshot", "reason": err.Error()})
		return
	}
	cs := containersOf(def, all)
	if len(cs) == 0 {
		msg := "Der Pod hat keine Container — erst starten, dann aktualisieren"
		emit(msg)
		result("failed", map[string]any{"stage": "snapshot", "reason": msg})
		return
	}

	oldDigests := map[string]string{}
	oldIDs := map[string]string{}
	refs := map[string]string{}
	units := map[string]string{}
	var filters []string
	for _, c := range cs {
		svc := serviceOf(c)
		policy := c.Labels[autoUpdateLabel]
		if policy == "" {
			emit("  " + svc + ": kein AutoUpdate= in der .container-Datei — bleibt unverändert")
			continue
		}
		digests := podmanImageDigests(ctx, c.ImageID)
		if len(digests) > 0 {
			oldDigests[svc] = digests[0]
			emit(fmt.Sprintf("  %s: %s  [AutoUpdate=%s]", svc, shortDigest(digests[0]), policy))
		} else {
			emit(fmt.Sprintf("  %s: %s (ohne Registry-Digest)  [AutoUpdate=%s]", svc, c.Image, policy))
		}
		oldIDs[svc] = c.ImageID
		refs[svc] = c.Image
		units[svc] = c.Labels["PODMAN_SYSTEMD_UNIT"]
		filters = append(filters, "--filter", "label=PODMAN_SYSTEMD_UNIT="+units[svc])
	}
	if len(filters) == 0 {
		msg := "Kein Container mit AutoUpdate=registry — in den .container-Dateien ergänzen"
		emit(msg)
		result("failed", map[string]any{"stage": "config", "reason": msg})
		return
	}

	before := map[string]psRow{}
	if rows, err := podPsRows(ctx, def); err == nil {
		for _, row := range rows {
			before[row.Service] = row
			if wasBrokenBefore(before, row.Service) {
				emit(fmt.Sprintf("  Ausgangslage: %s ist %s/%s — bereits vor dem Update auffällig", row.Service, row.State, row.Health))
			}
		}
	}

	// Pull + Neustart + Podmans eigener Rollback bei gescheitertem Neustart
	emit("podman auto-update …")
	args := append([]string{"auto-update", "--format", "json"}, filters...)
	cmd := exec.CommandContext(ctx, "podman", args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &sseWriter{w: w, f: f}
	runErr := cmd.Run()

	var reports []autoUpdateReport
	if s := strings.TrimSpace(stdout.String()); s != "" && json.Unmarshal([]byte(s), &reports) != nil {
		emit(s)
	}
	updated := map[string]bool{}
	var failed, rolledBack []string
	for _, rep := range reports {
		svc := strings.TrimSuffix(rep.unit(), ".service")
		status := strings.ToLower(rep.Updated)
		emit(fmt.Sprintf("  %s: %s", svc, rep.Updated))
		switch {
		case status == "true":
			updated[svc] = true
		case strings.Contains(status, "roll"):
			rolledBack = append(rolledBack, svc)
		case status == "failed":
			failed = append(failed, svc)
		}
	}
	if len(rolledBack) > 0 {
		reason := "Neustart nach dem Update gescheitert, Podman hat zurückgerollt: " + strings.Join(rolledBack, ", ")
		emit("✓ " + reason)
		result("rolled_back", map[string]any{"stage": "restart", "reason": reason, "old_digests": oldDigests})
		return
	}
	if runErr != nil || len(failed) > 0 {
		reason := "podman auto-update fehlgeschlagen"
		if len(failed) > 0 {
			reason += ": " + strings.Join(failed, ", ")
		}
		// Ohne Bericht kam es nicht bis zum Neustart — fast immer der Pull
		stage := "restart"
		if len(reports) == 0 {
			stage = "pull"
		}
		emit(reason)
		result("failed", map[string]any{"stage": stage, "reason": reason, "old_digests": oldDigests})
		return
	}
	if len(updated) == 0 {
		emit("✓ Keine neuen Images — nichts zu tun.")
		result("success", map[string]any{"old_digests": oldDigests, "new_digests": oldDigests})
		return
	}

	emit(fmt.Sprintf("Stabilisierungsfenster: %d Sekunden …", window))
	snapshot := func(ctx context.Context) ([]psRow, error) { return podPsRows(ctx, def) }
	if reason := stabilizeWith(ctx, window, before, emit, snapshot); reason != "" {
		if ctx.Err() != nil {
			emit("Beobachtung abgebrochen (Zeitlimit) — kein Rollback, Zustand nicht bewertet.")
			result("failed", map[string]any{"stage": "stabilize", "reason": "Beobachtung abgebrochen — kein Rollback ausgeführt", "old_digests": oldDigests})
			return
		}
		emit("Instabil: " + reason + " — Rollback …")
		podRollback(ctx, def, updated, oldIDs, refs, units, oldDigests, before, reason, emit, result)
		return
	}

	newDigests := map[string]string{}
	if imgs, err := podImages(ctx, def); err == nil {
		for _, img := range imgs {
			// Nur die Container, die auto-update angefasst hat — sonst sähe die
			// Historie unberührte Dienste als „geändert"
			if _, touched := oldIDs[img.Service]; touched && img.Digest != "" {
				newDigests[img.Service] = img.Digest
			}
		}
	}
	emit("✓ Update erfolgreich, alle Container stabil.")
	result("success", map[string]any{"old_digests": oldDigests, "new_digests": newDigests})
}

// Altes Image wieder unter den Namen taggen und die Units neu starten — genau
// das, was Podman bei gescheitertem Neustart selbst tut. Quadlet erzeugt den
// Container bei jedem Start neu, also läuft danach das alte Image.
func podRollback(ctx context.Context, def podDef, updated map[string]bool, oldIDs, refs, units, oldDigests map[string]string,
	before map[string]psRow, reason string, emit func(string), result func(string, map[string]any)) {
	var restart []string
	for svc := range updated {
		if oldIDs[svc] == "" || refs[svc] == "" {
			continue
		}
		if out, err := run(ctx, "", 30*time.Second, "podman", "tag", oldIDs[svc], refs[svc]); err != nil {
			emit("  " + svc + ": Zurücktaggen fehlgeschlagen: " + firstLine(out))
			continue
		}
		emit("  " + svc + ": altes Image wieder als " + refs[svc] + " getaggt")
		restart = append(restart, units[svc])
	}
	if len(restart) == 0 {
		result("failed", map[string]any{"stage": "rollback", "reason": reason + " — Rollback nicht möglich", "old_digests": oldDigests})
		return
	}
	sort.Strings(restart)
	if out, err := run(ctx, "", 3*time.Minute, "systemctl", append([]string{"--user", "restart"}, restart...)...); err != nil {
		emit("Neustart fehlgeschlagen: " + firstLine(out))
		result("failed", map[string]any{"stage": "rollback", "reason": reason + " — Neustart beim Rollback fehlgeschlagen", "old_digests": oldDigests})
		return
	}
	snapshot := func(ctx context.Context) ([]psRow, error) { return podPsRows(ctx, def) }
	if still := stabilizeWith(ctx, 30, before, emit, snapshot); still != "" {
		emit("⚠ Auch nach dem Rollback instabil: " + still)
		result("failed", map[string]any{
			"stage":       "rollback",
			"reason":      still + " (bestand auch nach dem Rollback — nicht durch das Update verursacht)",
			"old_digests": oldDigests,
		})
		return
	}
	emit("✓ Rollback aktiv — Pod läuft wieder auf altem Stand.")
	result("rolled_back", map[string]any{"reason": reason, "old_digests": oldDigests})
}

// ── Automatische Updates: podman-auto-update.timer ─────────────────────────
//
// Bei Podman ist „automatisch" kein Dockposer-Zeitplan, sondern Podmans eigener
// systemd-Timer: Er ruft (Standard: täglich um Mitternacht) `podman auto-update`
// für alle Container mit AutoUpdate= auf — serverweit, nicht pro Pod. Dockposer
// zeigt ihn an und schaltet ihn; was er aktualisiert hat, erkennt der Core beim
// nächsten Prüflauf und trägt es in die Historie ein.

const autoUpdateTimer = "podman-auto-update.timer"

type timerState struct {
	Enabled    bool   `json:"enabled"`
	Active     bool   `json:"active"`
	NextRun    string `json:"next_run,omitempty"`    // RFC3339
	LastRun    string `json:"last_run,omitempty"`    // RFC3339
	LastResult string `json:"last_result,omitempty"` // success, exit-code, …
}

func systemdShow(ctx context.Context, unit string, props ...string) map[string]string {
	args := []string{"--user", "show", unit, "--timestamp=unix"}
	for _, p := range props {
		args = append(args, "-p", p)
	}
	out, _ := run(ctx, "", 10*time.Second, "systemctl", args...)
	res := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			res[k] = v
		}
	}
	return res
}

// "@1795830000" → RFC3339; leer/0 → "". Ältere systemd ignorieren
// --timestamp=unix bei `show` und schreiben "Sat 2026-11-28 00:00:00 CET".
func unixStamp(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || v == "0" || v == "n/a" {
		return ""
	}
	if n, err := strconv.ParseInt(strings.TrimPrefix(v, "@"), 10, 64); err == nil {
		if n <= 0 {
			return ""
		}
		return time.Unix(n, 0).UTC().Format(time.RFC3339)
	}
	if t, err := time.ParseInLocation("Mon 2006-01-02 15:04:05 MST", v, time.Local); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	return ""
}

func readTimerState(ctx context.Context) timerState {
	t := systemdShow(ctx, autoUpdateTimer, "UnitFileState", "ActiveState", "NextElapseUSecRealtime", "LastTriggerUSec")
	s := systemdShow(ctx, "podman-auto-update.service", "Result")
	st := timerState{
		Enabled: t["UnitFileState"] == "enabled",
		Active:  t["ActiveState"] == "active",
		NextRun: unixStamp(t["NextElapseUSecRealtime"]),
		LastRun: unixStamp(t["LastTriggerUSec"]),
	}
	if st.LastRun != "" {
		st.LastResult = s["Result"]
	}
	return st
}

// GET /v1/pods-autoupdate
func handleAutoUpdateTimer(w http.ResponseWriter, r *http.Request) {
	if !podsEnabled {
		httpErr(w, 404, "Pods sind auf diesem Server nicht aktiv")
		return
	}
	writeJSON(w, readTimerState(r.Context()))
}

// POST /v1/pods-autoupdate {"enabled": true|false}
func handleAutoUpdateTimerSet(w http.ResponseWriter, r *http.Request) {
	if !podsEnabled {
		httpErr(w, 404, "Pods sind auf diesem Server nicht aktiv")
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, 400, "ungültiger Body")
		return
	}
	verb := "disable"
	if req.Enabled {
		verb = "enable"
	}
	if out, err := run(r.Context(), "", 30*time.Second, "systemctl", "--user", verb, "--now", autoUpdateTimer); err != nil {
		httpErr(w, 500, "systemctl --user "+verb+" fehlgeschlagen: "+firstLine(out))
		return
	}
	writeJSON(w, readTimerState(r.Context()))
}
