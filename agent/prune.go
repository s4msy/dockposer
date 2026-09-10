package main

// Aufräumen nach Updates.
//
// Jeder Update-Lauf lässt das alte Image ohne Tag zurück — es wird zu
// `<none>:<none>`, also „dangling". Genau das füllt über Monate die Platte,
// vor der Dockposer selbst warnt. Deshalb gehört die Aufräumaktion hierher:
// Sie schließt den Kreis zum Disk-Alarm.
//
// Bewusst konservativ: nur unbenutzte Images OHNE Tag. Ein `prune -a` würde
// auch getaggte Images gestoppter Stacks löschen — die müssten beim nächsten
// `up -d` neu gezogen werden, und ohne Netz oder bei verschwundenem Tag steht
// der Stack still. Das ist es nicht wert.

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type pruneInfo struct {
	Images int    `json:"images"` // Anzahl ungetaggter Images
	Bytes  int64  `json:"bytes"`  // freigebbar
	Error  string `json:"error,omitempty"`
}

// docker image ls --filter dangling=true --format json → eine JSON-Zeile je Image
func danglingInfo(r *http.Request) pruneInfo {
	out, err := run(r.Context(), "", 30*time.Second,
		"docker", "image", "ls", "--filter", "dangling=true", "--format", "{{json .}}")
	if err != nil {
		return pruneInfo{Error: strings.TrimSpace(out)}
	}
	var info pruneInfo
	for _, line := range nonEmptyLines(out) {
		var row struct {
			Size string `json:"Size"`
		}
		if json.Unmarshal([]byte(line), &row) != nil {
			continue
		}
		info.Images++
		info.Bytes += parseHumanSize(row.Size)
	}
	return info
}

func handlePruneInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, danglingInfo(r))
}

func handlePrune(w http.ResponseWriter, r *http.Request) {
	before := danglingInfo(r)
	out, err := run(r.Context(), "", 5*time.Minute, "docker", "image", "prune", "-f")
	if err != nil {
		httpErr(w, 500, strings.TrimSpace(out))
		return
	}
	// Die von Docker gemeldete Summe ist die verlässlichere Zahl; unsere
	// Vorab-Schätzung dient nur als Rückfallwert, falls die Zeile fehlt.
	freed := reclaimedFromOutput(out)
	if freed == 0 {
		freed = before.Bytes
	}
	writeJSON(w, map[string]any{"images": before.Images, "bytes": freed, "output": strings.TrimSpace(out)})
}

// „Total reclaimed space: 1.234GB" → Bytes
func reclaimedFromOutput(out string) int64 {
	for _, line := range nonEmptyLines(out) {
		if i := strings.Index(line, "reclaimed space:"); i >= 0 {
			return parseHumanSize(strings.TrimSpace(line[i+len("reclaimed space:"):]))
		}
	}
	return 0
}

// „1.234GB", „512.3MB", „0B" → Bytes. Docker mischt Dezimal- und Binärpräfixe
// je nach Ausgabe; für eine Anzeige „ungefähr so viel wird frei" reicht das.
func parseHumanSize(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	units := []struct {
		suffix string
		factor float64
	}{
		{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10},
		{"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"KB", 1e3}, {"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			n, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, u.suffix)), 64)
			if err != nil {
				return 0
			}
			// Runden statt Abschneiden: 512.3*1e6 ergibt in float64 knapp darunter
			// und würde sonst als 512299999 durchgehen.
			return int64(math.Round(n * u.factor))
		}
	}
	return 0
}
