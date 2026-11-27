package main

import "testing"

func TestUnixStamp(t *testing.T) {
	for in, want := range map[string]string{
		"@1795830000": "2026-11-28T01:40:00Z",
		"":            "",
		"0":           "",
		"n/a":         "",
		"@0":          "",
	} {
		if got := unixStamp(in); got != want {
			t.Errorf("%q: %q, erwartet %q", in, got, want)
		}
	}
	if unixStamp("Sat 2026-11-28 00:00:00 UTC") == "" {
		t.Error("Textform nicht erkannt")
	}
}

func TestAutoUpdateReportUnit(t *testing.T) {
	if (autoUpdateReport{SystemdUnit: "a.service"}).unit() != "a.service" {
		t.Error("SystemdUnit-Fallback")
	}
	if (autoUpdateReport{Unit: "b.service", SystemdUnit: "a.service"}).unit() != "b.service" {
		t.Error("Unit hat Vorrang")
	}
}
