//go:build windows

package main

import (
	"slices"
	"testing"
)

func TestParseLaunch(t *testing.T) {
	line := `{"schema":"figure-library.local-launch.v1","version":"0.9.2","origin":"http://127.0.0.1:5123","token":"t","url":"http://127.0.0.1:5123/#connect=x"}` + "\n"
	info, ok := parseLaunch(line)
	if !ok || info.Origin != "http://127.0.0.1:5123" || info.Token != "t" {
		t.Fatalf("parseLaunch(valid) = %+v, %v", info, ok)
	}
	for _, bad := range []string{
		"If the browser did not open, paste this address",
		`{"schema":"other","origin":"http://127.0.0.1:1","token":"t","url":"http://127.0.0.1:1/"}`,
		`{"schema":"figure-library.local-launch.v1","origin":"http://example.com","token":"t","url":"http://example.com/"}`,
		`{"schema":"figure-library.local-launch.v1","origin":"http://127.0.0.1:1","token":"","url":"http://127.0.0.1:1/"}`,
		`{"schema":"figure-library.local-launch.v1","origin":"http://127.0.0.1:1","token":"t","url":"http://127.0.0.2:1/"}`,
	} {
		if _, ok := parseLaunch(bad); ok {
			t.Errorf("parseLaunch(%q) accepted", bad)
		}
	}
}

func TestParseNodeMajor(t *testing.T) {
	for input, want := range map[string]int{"v22.12.0\r\n": 22, "v24.1.3": 24, "v20.0.0": 20} {
		if got, err := parseNodeMajor(input); err != nil || got != want {
			t.Errorf("parseNodeMajor(%q) = %d, %v", input, got, err)
		}
	}
	if _, err := parseNodeMajor("node"); err == nil {
		t.Error("parseNodeMajor accepted a non-version")
	}
}

func TestBackendEnvDropsNodeInjection(t *testing.T) {
	got := backendEnv([]string{"PATH=C:\\Windows", "node_options=--require x", "NODE_PATH=y", "SFL_NODE_BINARY=z"})
	if !slices.Equal(got, []string{"PATH=C:\\Windows", "SFL_NODE_BINARY=z"}) {
		t.Fatalf("backendEnv = %v", got)
	}
}

func TestExternalURL(t *testing.T) {
	if got, err := externalURL("https://github.com/xuzhougeng/ScientificFigureLibrary"); err != nil || got == "" {
		t.Fatalf("externalURL(github) = %q, %v", got, err)
	}
	for _, bad := range []string{"file:///C:/Windows/notepad.exe", "http://127.0.0.1:5123/", "http://localhost/", "http://[::1]/", "javascript:alert(1)", "ms-settings:"} {
		if _, err := externalURL(bad); err == nil {
			t.Errorf("externalURL(%q) accepted", bad)
		}
	}
}
