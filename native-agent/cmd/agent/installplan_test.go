package main

import (
	"encoding/json"
	"testing"
)

func TestInstallSettingsOmitsWhatWasNotGiven(t *testing.T) {
	settings := installSettings(installOptions{token: "tok", watchPaths: []string{`C:\Data`}})
	if _, ok := settings["connectIp"]; ok {
		t.Fatalf("an unset option must be absent, not empty: %v", settings)
	}
	if _, ok := settings["serverUrl"]; ok {
		t.Fatalf("an unset server URL must be absent so the agent's default applies: %v", settings)
	}
	if _, ok := settings["caCertFile"]; ok {
		t.Fatalf("no CA was requested: %v", settings)
	}
}

func TestInstallSettingsCarriesEverythingGiven(t *testing.T) {
	settings := installSettings(installOptions{
		serverURL:  "https://dsp.example.com/api",
		token:      "tok",
		watchPaths: []string{`C:\Users\jdoe\Downloads`},
		connectIP:  "20.20.0.92",
		caPath:     embeddedCAName,
	})
	want := map[string]any{
		"serverUrl":   "https://dsp.example.com/api",
		"enrollToken": "tok",
		"watchPath":   `C:\Users\jdoe\Downloads`,
		"connectIp":   "20.20.0.92",
		"caCertFile":  caFileName,
	}
	for key, value := range want {
		if settings[key] != value {
			t.Errorf("%s = %q, want %q", key, settings[key], value)
		}
	}
}

// Whatever CA was asked for, the agent reads it from one known filename in
// its own folder — a path typed at install time must not end up in the
// config, where it would break the moment that file moved.
func TestACAPathBecomesTheLocalFilename(t *testing.T) {
	settings := installSettings(installOptions{token: "t", watchPaths: []string{"/d"}, caPath: `D:\certs\corp-root.pem`})
	if settings["caCertFile"] != caFileName {
		t.Fatalf("got %q", settings["caCertFile"])
	}
}

// A Windows path is full of backslashes; they have to survive the round trip
// into agent.json and back.
func TestSettingsSurviveJSONRoundTrip(t *testing.T) {
	body, err := marshalSettings(installSettings(installOptions{token: "t", watchPaths: []string{`C:\Users\jdoe\Downloads`}}))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatal(err)
	}
	if back["watchPath"] != any(`C:\Users\jdoe\Downloads`) {
		t.Fatalf("got %q", back["watchPath"])
	}
}

func TestParseInstallOptions(t *testing.T) {
	o, err := parseInstallOptions([]string{
		"-server", "https://dsp.example.com/api", "-ip", "20.20.0.92",
		"-token", "abc", "-watch", `C:\Users\jdoe\Downloads`, "-ca", embeddedCAName,
	})
	if err != nil {
		t.Fatal(err)
	}
	if o.serverURL != "https://dsp.example.com/api" || o.connectIP != "20.20.0.92" || o.token != "abc" {
		t.Fatalf("got %+v", o)
	}
	if o.targetDir == "" {
		t.Fatal("an install directory should always be defaulted")
	}
}

func TestParseInstallOptionsRejectsUnknownFlags(t *testing.T) {
	if _, err := parseInstallOptions([]string{"-nonsense", "x"}); err == nil {
		t.Fatal("expected an unknown flag to be rejected")
	}
}

// Several folders switch the config to the list form. One folder must not,
// because the single-folder form is what an existing machine's agent key is
// derived from — writing the list form would silently orphan its history.
func TestOneFolderKeepsTheSingularForm(t *testing.T) {
	single := installSettings(installOptions{token: "t", watchPaths: []string{`C:\Users`}})
	if single["watchPath"] != any(`C:\Users`) {
		t.Fatalf("got %v", single)
	}
	if _, ok := single["watchPaths"]; ok {
		t.Fatalf("the list form should be absent: %v", single)
	}

	many := installSettings(installOptions{token: "t", watchPaths: []string{`C:\Users`, `D:\`}})
	if _, ok := many["watchPath"]; ok {
		t.Fatalf("the singular form should be absent: %v", many)
	}
	paths, ok := many["watchPaths"].([]string)
	if !ok || len(paths) != 2 {
		t.Fatalf("got %v", many)
	}
}

func TestAllDrivesAndExclusionsReachTheConfig(t *testing.T) {
	settings := installSettings(installOptions{token: "t", allDrives: true, exclude: []string{`D:\backups`}})
	if settings["watchAllFixedDrives"] != any(true) {
		t.Fatalf("got %v", settings)
	}
	if excluded, ok := settings["exclude"].([]string); !ok || excluded[0] != `D:\backups` {
		t.Fatalf("got %v", settings)
	}
}

func TestParseInstallOptionsSplitsListsOnSemicolons(t *testing.T) {
	o, err := parseInstallOptions([]string{"-token", "t", "-watch", `C:\Users; D:\`, "-all-drives", "-exclude", `D:\build; **/node_modules`})
	if err != nil {
		t.Fatal(err)
	}
	if len(o.watchPaths) != 2 || o.watchPaths[1] != `D:\` {
		t.Fatalf("got %v", o.watchPaths)
	}
	if !o.allDrives || len(o.exclude) != 2 {
		t.Fatalf("got %+v", o)
	}
}

func TestRemovableReachesTheConfig(t *testing.T) {
	settings := installSettings(installOptions{token: "t", removable: true})
	if settings["watchRemovableDrives"] != any(true) {
		t.Fatalf("got %v", settings)
	}
	if _, ok := installSettings(installOptions{token: "t", watchPaths: []string{`C:\x`}})["watchRemovableDrives"]; ok {
		t.Fatal("removable watching must be opt-in")
	}
}
