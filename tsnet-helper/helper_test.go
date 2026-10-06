package main

import (
	"bufio"
	"context"
	"encoding/json/v2"
	"io"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

const eventTimeout = 60 * time.Second

func startControl(t *testing.T) (string, *testcontrol.Server) {
	t.Helper()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	control := &testcontrol.Server{
		DERPMap:        integration.RunDERPAndSTUN(t, logger.Discard, "127.0.0.1"),
		DNSConfig:      &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "tail-scale.ts.net",
		RequireAuth:    true,
		Logf:           logger.Discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	return control.HTTPTestServer.URL, control
}

type runningHelper struct {
	events <-chan event
	stop   func()
}

func startHelper(t *testing.T, cfg config) *runningHelper {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, cfg, writer)
		writer.Close()
	}()
	events := make(chan event, 16)
	go func() {
		defer close(events)
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var ev event
			if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
				t.Errorf("helper wrote a line that is not an event: %q", scanner.Text())
				continue
			}
			events <- ev
		}
	}()
	h := &runningHelper{
		events: events,
		stop: sync.OnceFunc(func() {
			cancel()
			<-done
			for range events {
			}
		}),
	}
	t.Cleanup(h.stop)
	return h
}

func (h *runningHelper) waitFor(t *testing.T, states ...string) event {
	t.Helper()
	deadline := time.After(eventTimeout)
	for {
		select {
		case ev, ok := <-h.events:
			if !ok {
				t.Fatalf("helper stopped before reporting %v", states)
			}
			for _, s := range states {
				if ev.State == s {
					return ev
				}
			}
		case <-deadline:
			t.Fatalf("no %v event within %v", states, eventTimeout)
		}
	}
}

func testConfig(controlURL, dir string) config {
	return config{
		Dir:        dir,
		Hostname:   "ostia-test",
		ControlURL: controlURL,
		Port:       8722,
		Target:     "127.0.0.1:1",
	}
}

func signIn(t *testing.T, control *testcontrol.Server, h *runningHelper) event {
	t.Helper()
	login := h.waitFor(t, "needs-login")
	if login.AuthURL == "" {
		t.Fatal("needs-login carried no login link")
	}
	if !control.CompleteAuth(login.AuthURL) {
		t.Fatalf("test control did not accept login link %q", login.AuthURL)
	}
	return h.waitFor(t, "running")
}

func testSignedInNodeRestartsWithoutLogin(t *testing.T) {
	controlURL, control := startControl(t)
	cfg := testConfig(controlURL, t.TempDir())

	first := startHelper(t, cfg)
	running := signIn(t, control, first)
	if running.IP == "" {
		t.Fatal("running carried no tailnet IPv4")
	}
	first.stop()

	second := startHelper(t, cfg)
	if ev := second.waitFor(t, "running", "needs-login"); ev.State != "running" {
		t.Fatalf("restart with the same state folder reported %q, want running without a login link", ev.State)
	}
}

func testSignOutRequiresLoginAgain(t *testing.T) {
	controlURL, control := startControl(t)
	cfg := testConfig(controlURL, t.TempDir())

	first := startHelper(t, cfg)
	signIn(t, control, first)
	first.stop()

	if err := logout(t.Context(), cfg); err != nil {
		t.Fatalf("logout: %v", err)
	}

	again := startHelper(t, cfg)
	if ev := again.waitFor(t, "running", "needs-login"); ev.State != "needs-login" {
		t.Fatalf("start after sign-out reported %q, want needs-login", ev.State)
	}
}

func TestTailnetHelper(t *testing.T) {
	t.Run("TSN-C16", testSignedInNodeRestartsWithoutLogin)
	t.Run("TSN-C17", testSignOutRequiresLoginAgain)
}
