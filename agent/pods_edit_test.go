package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePod(t *testing.T, root, pod string, files map[string]string) {
	t.Helper()
	os.MkdirAll(filepath.Join(root, pod), 0o755)
	for f, c := range files {
		if err := os.WriteFile(filepath.Join(root, pod, f), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// Fehler eines Nachbar-Pods blockieren nicht, eigene schon — braucht den
// echten Quadlet-Generator, sonst übersprungen.
func TestValidatePodAttributesErrors(t *testing.T) {
	if gen, _ := quadletGenerator(); gen == "" {
		t.Skip("Quadlet-Generator nicht installiert")
	}
	podsDir = t.TempDir()
	writePod(t, podsDir, "broken", map[string]string{"other.container": "[Container]\n"})

	val, err := validatePod(context.Background(), "mine", map[string][]byte{
		"mine.container": []byte("[Container]\nImage=docker.io/library/nginx:alpine\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(val.Errors) != 0 {
		t.Fatalf("Nachbarfehler darf nicht blockieren: %v", val.Errors)
	}

	val, _ = validatePod(context.Background(), "mine", map[string][]byte{"mine.container": []byte("[Container]\n")})
	if len(val.Errors) != 1 || !strings.Contains(val.Errors[0], "mine.container") {
		t.Fatalf("eigener Fehler fehlt: %v", val.Errors)
	}
	if strings.Contains(val.Errors[0], podsDir) || strings.Contains(val.Errors[0], os.TempDir()+"/dockposer-quadlet") {
		t.Fatalf("Temp-Pfad sickert in die Meldung: %q", val.Errors[0])
	}

	val, _ = validatePod(context.Background(), "mine", map[string][]byte{"mine.container": []byte("[Container]\nImage=nginx\n")})
	if len(val.Errors) != 0 || len(val.Warnings) == 0 {
		t.Fatalf("Kurzname sollte Hinweis, kein Fehler sein: %+v", val)
	}
}

// Vorhandene Fehler kommen als Hinweis zurück, neue blockieren.
func TestValidatePodChangeOnlyNewErrors(t *testing.T) {
	if gen, _ := quadletGenerator(); gen == "" {
		t.Skip("Quadlet-Generator nicht installiert")
	}
	podsDir = t.TempDir()
	before := map[string][]byte{
		"a.container": []byte("[Container]\n"),
		"b.container": []byte("[Container]\nImage=docker.io/library/nginx:alpine\n"),
	}
	after := map[string][]byte{
		"a.container": []byte("[Container]\n"),
		"b.container": []byte("[Container]\nImage=docker.io/library/nginx:1\n"),
	}
	val, err := validatePodChange(context.Background(), "p", before, after)
	if err != nil || len(val.Errors) != 0 {
		t.Fatalf("Altfehler darf Reparatur nebenan nicht blockieren: %+v %v", val, err)
	}
	after["b.container"] = []byte("[Container]\n")
	val, _ = validatePodChange(context.Background(), "p", before, after)
	if len(val.Errors) != 1 || !strings.Contains(val.Errors[0], "b.container") {
		t.Fatalf("neuer Fehler muss blockieren: %+v", val)
	}
}

func TestDuplicateFileNamesAcrossPods(t *testing.T) {
	podsDir = t.TempDir()
	writePod(t, podsDir, "alpha", map[string]string{"web.container": "[Container]\nImage=x\n", "shared.network": "[Network]\n"})
	dups := duplicateUnits("beta", map[string][]byte{
		"web.container":  []byte("[Container]\nImage=y\n"),
		"shared.network": []byte("[Network]\n"),
		"own.env":        []byte("A=1\n"),
	})
	if len(dups) != 2 {
		t.Fatalf("erwartet 2 Kollisionen (Container + Netzwerk, eine Meldung je Datei), bekam %v", dups)
	}
	// ServiceName= im anderen Pod belegt den Dienstnamen
	writePod(t, podsDir, "gamma", map[string]string{"x.container": "[Container]\nImage=x\nServiceName=api\n"})
	dups = duplicateUnits("beta", map[string][]byte{"y.container": []byte("[Container]\nImage=y\nServiceName=api\n")})
	if len(dups) != 1 || !strings.Contains(dups[0], "api.service") {
		t.Fatalf("Dienstnamen-Kollision fehlt: %v", dups)
	}
	// eigener Pod zählt nicht
	if d := duplicateUnits("alpha", map[string][]byte{"web.container": []byte("[Container]\nImage=z\n")}); len(d) != 0 {
		t.Fatalf("eigene Datei ist keine Kollision: %v", d)
	}
}

func TestPodFileNames(t *testing.T) {
	for name, ok := range map[string]bool{
		"web.container": true, "a.pod": true, "x.env": true, "n.network": true,
		".env": false, "../x.container": false, "a/b.container": false, "x.kube": false, "x.yaml": false,
	} {
		if podFileRe.MatchString(name) != ok {
			t.Errorf("%q: erwartet %v", name, ok)
		}
	}
}
