package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "beckon")
	t.Setenv("BECKON_CONFIG_DIR", dir)
	if _, err := Load(); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("want ErrNotLoggedIn, got %v", err)
	}
	want := Credentials{Server: "http://x", HostToken: "tok", HostID: "h", Label: "l"}
	if err := Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := Load()
	if err != nil || got != want {
		t.Fatalf("got %+v, %v", got, err)
	}
	fi, _ := os.Stat(filepath.Join(dir, "credentials.json"))
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode %v", fi.Mode().Perm())
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o700 {
		t.Errorf("dir mode %v", di.Mode().Perm())
	}
}

func TestDirPrecedence(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", "/xdg")
	if d, _ := Dir(); d != "/xdg/beckon" {
		t.Errorf("xdg: %s", d)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/home/u")
	if d, _ := Dir(); d != "/home/u/.config/beckon" {
		t.Errorf("home: %s", d)
	}
}
