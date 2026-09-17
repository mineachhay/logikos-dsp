package main

import (
	"encoding/json"
	"testing"
)

func TestInstallSettingsOmitsWhatWasNotGiven(t *testing.T) {
	settings := installSettings(installOptions{token: "tok", watchPath: `C:\Data`})
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
		serverURL: "https://dsp.example.com/api",
		token:     "tok",
		watchPath: `C:\Users\jdoe\Downloads`,
		connectIP: "20.20.0.92",
		caPath:    embeddedCAName,
	})
	want := map[string]string{
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
	settings := installSettings(installOptions{token: "t", watchPath: "/d", caPath: `D:\certs\corp-root.pem`})
	if settings["caCertFile"] != caFileName {
		t.Fatalf("got %q", settings["caCertFile"])
	}
}

// A Windows path is full of backslashes; they have to survive the round trip
// into agent.json and back.
func TestSettingsSurviveJSONRoundTrip(t *testing.T) {
	body, err := marshalSettings(installSettings(installOptions{token: "t", watchPath: `C:\Users\jdoe\Downloads`}))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]string
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatal(err)
	}
	if back["watchPath"] != `C:\Users\jdoe\Downloads` {
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
