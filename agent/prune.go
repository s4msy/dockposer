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

// Größenschätzung.
//
// `docker image ls` meldet je Image die VOLLE Größe inklusive aller Ebenen —
// auch derer, die das Image sich mit anderen teilt. Nach einem Update teilt
// sich das alte Image fast alle Basis-Ebenen mit dem neuen; gelöscht wird nur,
// was sonst niemand mehr braucht. Die Summe der Einzelgrößen liegt deshalb
// systematisch zu hoch (gemessen: 18,5 GB angekündigt, 15,6 GB freigeworden).
//
// `docker system df -v` kennt die tatsächlich exklusive Größe je Image
// ("UniqueSize"). Die nehmen wir, wenn verfügbar; sonst bleibt die alte
// Schätzung als Rückfall — dann lieber ungenau als gar keine Angabe.

type dfImage struct {
	Repository string          `json:"Repository"`
	Tag        string          `json:"Tag"`
	Size       json.RawMessage `json:"Size"`
	UniqueSize json.RawMessage `json:"UniqueSize"`
	Containers json.RawMessage `json:"Containers"`
}

// Docker liefert Größen je nach Version als "1.23GB" oder als blanke Zahl.
func sizeValue(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return parseHumanSize(s)
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return int64(math.Round(n))
	}
	return 0
}

func inUse(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s != "" && s != "0" && s != "N/A"
	}
	var n float64
	return json.Unmarshal(raw, &n) == nil && n > 0
}

func danglingFromDf(r *http.Request) (pruneInfo, bool) {
	out, err := run(r.Context(), "", 60*time.Second,
		"docker", "system", "df", "-v", "--format", "{{json .Images}}")
	if err != nil {
		return pruneInfo{}, false
	}
	var rows []dfImage
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &rows) != nil || len(rows) == 0 {
		return pruneInfo{}, false
	}
	var info pruneInfo
	for _, row := range rows {
		if row.Repository != "<none>" || row.Tag != "<none>" {
			continue
		}
		// Ein noch laufender Container hält sein Image fest — prune rührt es nicht an.
		if inUse(row.Containers) {
			continue
		}
		info.Images++
		if u := sizeValue(row.UniqueSize); u > 0 {
			info.Bytes += u
		} else {
			info.Bytes += sizeValue(row.Size)
		}
	}
	return info, true
}

// Rückfall: docker image ls --filter dangling=true. Zählt geteilte Ebenen mit
// und liegt damit zu hoch — besser als keine Angabe, wenn `system df` fehlt.
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

func pruneEstimate(r *http.Request) pruneInfo {
	if info, ok := danglingFromDf(r); ok {
		return info
	}
	return danglingInfo(r)
}

func handlePruneInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, pruneEstimate(r))
}

func handlePrune(w http.ResponseWriter, r *http.Request) {
	before := pruneEstimate(r)
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
