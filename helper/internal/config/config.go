// Package config stores the helper's credentials under ~/.config/beckon/.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Credentials are written by `beckon login`.
type Credentials struct {
	Server    string `json:"server"`
	HostToken string `json:"host_token"`
	HostID    string `json:"host_id"`
	Label     string `json:"label"`
}

// ErrNotLoggedIn means no credentials file exists.
var ErrNotLoggedIn = errors.New("not logged in")

// Dir returns $BECKON_CONFIG_DIR, else $XDG_CONFIG_HOME/beckon, else
// ~/.config/beckon. (Not os.UserConfigDir, which is ~/Library on macOS.)
func Dir() (string, error) {
	if d := os.Getenv("BECKON_CONFIG_DIR"); d != "" {
		return d, nil
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "beckon"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "beckon"), nil
}

// Load reads the credentials, returning ErrNotLoggedIn if there are none.
func Load() (Credentials, error) {
	var c Credentials
	p, err := File("credentials.json")
	if err != nil {
		return c, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return c, ErrNotLoggedIn
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Server == "" || c.HostToken == "" {
		return c, ErrNotLoggedIn
	}
	return c, nil
}

// Save writes the credentials atomically with mode 0600 (directory 0700).
func Save(c Credentials) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return WriteFile("credentials.json", append(b, '\n'))
}

// File returns the path of name inside the config directory.
func File(name string) (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, name), nil
}

// WriteFile atomically replaces name in the config directory with data,
// mode 0600 (directory 0700).
func WriteFile(name string, data []byte) error {
	p, err := File(name)
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+name+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
