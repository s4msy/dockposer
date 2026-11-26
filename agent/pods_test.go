package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Echte Zeilen aus `podman events --format json` (aufgezeichnet mit einem
// nachgestellten Quadlet-Pod: Infra-Container, web mit Healthcheck, db mit Exit 3).
var (
	evInfraStart = `{"ID":"463ad489b21a71ac1701d6c24b3164bd669593c9c22a196235b15c807bb85d4f","Image":"localhost/podman-pause:4.9.3-0","Name":"776a3888b023-infra","Status":"start","Time":"2026-11-26T06:45:02.151840167Z","Type":"container","PodID":"776a3888b023449c4a3f51e619c28a08ad03400d53b07c5d80c096dd42c03cbb","Attributes":{"PODMAN_SYSTEMD_UNIT":"paperless-pod.service","io.buildah.version":"1.33.7"}}`
	evWebStart   = `{"ID":"9d61258adc2714faee518601e478b865db7fdd6079107cb2b2f74e4bb7425ba9","Image":"localhost/bb:1","Name":"systemd-web","Status":"start","Time":"2026-11-26T06:45:02.217526422Z","Type":"container","PodID":"776a3888b023449c4a3f51e619c28a08ad03400d53b07c5d80c096dd42c03cbb","Attributes":{"PODMAN_SYSTEMD_UNIT":"web.service"}}`
	evDbDied     = `{"ContainerExitCode":3,"ID":"d2ce094ba26a9f54872b252032fadaeeac8f415393bac94426c9d0e762fcac05","Image":"localhost/bb:1","Name":"systemd-db","Status":"died","Time":"2026-11-26T06:45:05.413993249Z","Type":"container","Attributes":{"PODMAN_SYSTEMD_UNIT":"db.service"}}`
	evWebHealthy = `{"ID":"9d61258adc2714faee518601e478b865db7fdd6079107cb2b2f74e4bb7425ba9","Image":"localhost/bb:1","Name":"systemd-web","Status":"health_status","Time":"2026-11-26T06:45:08.529507211Z","Type":"container","health_status":"healthy","PodID":"776a3888b023449c4a3f51e619c28a08ad03400d53b07c5d80c096dd42c03cbb","Attributes":{"PODMAN_SYSTEMD_UNIT":"web.service"}}`
)

var testUnits = map[string]string{"web.service": "paperless", "db.service": "paperless"}

func decode(t *testing.T, line string) (string, map[string]string) {
	t.Helper()
	var e struct {
		Action string
		Actor  struct{ Attributes map[string]string }
	}
	if err := json.Unmarshal([]byte(line), &e); err != nil {
		t.Fatalf("Ausgabe kein JSON: %v", err)
	}
	return e.Action, e.Actor.Attributes
}

func TestInfraContainerIgnored(t *testing.T) {
	if out := normalizePodmanEvent(evInfraStart, testUnits); len(out) != 0 {
		t.Fatalf("Infra-Container darf kein Ereignis erzeugen, bekam %v", out)
	}
}

func TestDiedBecomesDieWithExitCode(t *testing.T) {
	out := normalizePodmanEvent(evDbDied, testUnits)
	if len(out) != 1 {
		t.Fatalf("erwartet 1 Zeile, bekam %d", len(out))
	}
	action, a := decode(t, out[0])
	if action != "die" || a["exitCode"] != "3" || a["com.docker.compose.project"] != "paperless" || a["name"] != "systemd-db" {
		t.Fatalf("falsch übersetzt: %s %v", action, a)
	}
}

func TestHealthStatusInDockerForm(t *testing.T) {
	out := normalizePodmanEvent(evWebHealthy, testUnits)
	if len(out) != 1 {
		t.Fatalf("erwartet 1 Zeile, bekam %d", len(out))
	}
	if action, _ := decode(t, out[0]); action != "health_status: healthy" {
		t.Fatalf("Action = %q", action)
	}
}

func TestStartPassesThrough(t *testing.T) {
	out := normalizePodmanEvent(evWebStart, testUnits)
	if len(out) != 1 {
		t.Fatalf("erwartet 1 Zeile, bekam %d", len(out))
	}
	if action, a := decode(t, out[0]); action != "start" || a["com.docker.compose.service"] != "web" {
		t.Fatalf("falsch: %s %v", action, a)
	}
}

func TestUnknownUnitIgnored(t *testing.T) {
	if out := normalizePodmanEvent(evDbDied, map[string]string{}); len(out) != 0 {
		t.Fatalf("Quadlet außerhalb der Pods-Ordner darf nicht gemeldet werden: %v", out)
	}
}

// Podman 6: OOM steht als Attribut am Exit; der Core erwartet wie bei Docker
// ein eigenes oom-Ereignis vor dem die.
func TestOOMKilledAttribute(t *testing.T) {
	line := `{"Name":"systemd-db","Status":"died","Type":"container","ContainerExitCode":137,"Attributes":{"PODMAN_SYSTEMD_UNIT":"db.service","OOMKilled":"true"}}`
	out := normalizePodmanEvent(line, testUnits)
	if len(out) != 2 {
		t.Fatalf("erwartet oom + die, bekam %d", len(out))
	}
	if a1, _ := decode(t, out[0]); a1 != "oom" {
		t.Fatalf("erste Zeile %q", a1)
	}
	if a2, attrs := decode(t, out[1]); a2 != "die" || attrs["exitCode"] != "137" {
		t.Fatalf("zweite Zeile %q %v", a2, attrs)
	}
}

func TestHealthFromStatus(t *testing.T) {
	cases := map[string]string{
		"Up 6 seconds (healthy)":   "healthy",
		"Up 2 minutes (unhealthy)": "unhealthy",
		"Up 1 second (starting)":   "starting",
		"Exited (3) 3 seconds ago": "",
	}
	for in, want := range cases {
		if got := healthFromStatus(in); got != want {
			t.Errorf("%q → %q, erwartet %q", in, got, want)
		}
	}
}

func TestReadPodAndServiceNames(t *testing.T) {
	dir := t.TempDir()
	podsDir = dir
	p := filepath.Join(dir, "paperless")
	os.MkdirAll(p, 0o755)
	os.WriteFile(filepath.Join(p, "paperless.pod"), []byte("[Pod]\n"), 0o644)
	os.WriteFile(filepath.Join(p, "web.container"), []byte("[Container]\nImage=x\nPod=paperless.pod\n"), 0o644)
	os.WriteFile(filepath.Join(p, "db.container"), []byte("[Container]\nImage=y\n[Service]\n\n[Container]\nServiceName=paperless-db\n"), 0o644)
	os.WriteFile(filepath.Join(p, "data.volume"), []byte("[Volume]\n"), 0o644)
	os.WriteFile(filepath.Join(p, "notes.txt"), []byte("egal"), 0o644)
	os.MkdirAll(filepath.Join(dir, "leer"), 0o755)

	def, ok := readPod("paperless")
	if !ok {
		t.Fatal("Pod nicht erkannt")
	}
	if def.PodUnit != "paperless-pod.service" {
		t.Errorf("PodUnit = %q", def.PodUnit)
	}
	want := []string{"paperless-db.service", "web.service"}
	if len(def.Containers) != 2 || def.Containers[0] != want[0] || def.Containers[1] != want[1] {
		t.Errorf("Container-Units = %v, erwartet %v", def.Containers, want)
	}
	if len(def.Files) != 4 {
		t.Errorf("Dateien = %v (notes.txt darf nicht dabei sein)", def.Files)
	}
	if _, ok := readPod("leer"); ok {
		t.Error("Ordner ohne Quadlet-Dateien darf kein Pod sein")
	}
	if _, ok := readPod("../etc"); ok {
		t.Error("Pfad-Traversal nicht abgewiesen")
	}
	if got := len(listPods()); got != 1 {
		t.Errorf("listPods = %d Pods, erwartet 1", got)
	}
}
