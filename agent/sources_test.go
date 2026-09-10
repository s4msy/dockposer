package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Der Installer baut mit --from-source aus einzeln heruntergeladenen Dateien;
// welche das sind, steht in sources.txt. Eine neue .go-Datei, die dort fehlt,
// bricht den Build auf JEDEM Server — und zwar erst beim Ausrollen, nicht hier.
// Dieser Test zieht den Fehler an die Stelle vor, an der er billig ist.
func TestSourcesManifestIsComplete(t *testing.T) {
	raw, err := os.ReadFile("sources.txt")
	if err != nil {
		t.Fatalf("sources.txt nicht lesbar: %v", err)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		if name := strings.TrimSpace(line); name != "" {
			listed[name] = true
		}
	}
	if !listed["go.mod"] {
		t.Error("go.mod fehlt in sources.txt — ohne sie schlägt der Build fehl")
	}

	entries, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range entries {
		if strings.HasSuffix(f, "_test.go") {
			continue // Tests werden nicht ausgeliefert
		}
		if !listed[f] {
			t.Errorf("%s fehlt in sources.txt — --from-source würde fehlschlagen", f)
		}
		delete(listed, f)
	}
	delete(listed, "go.mod")
	for name := range listed {
		t.Errorf("sources.txt nennt %s, die Datei gibt es nicht mehr", name)
	}
}
