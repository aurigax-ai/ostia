package main

import (
	"context"
	"encoding/json/v2"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

var version = "dev"

const dialTimeout = 5 * time.Second

type config struct {
	Dir         string
	Hostname    string
	ControlURL  string
	Port        int
	Target      string
	ListenLocal string
}

type event struct {
	State   string `json:"state"`
	AuthURL string `json:"authUrl,omitempty"`
	IP      string `json:"ip,omitempty"`
	DNSName string `json:"dnsName,omitempty"`
	Code    string `json:"code,omitempty"`
}

type emitter struct {
	mu   sync.Mutex
	out  io.Writer
	last event
}

func (e *emitter) send(ev event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if ev == e.last {
		return
	}
	e.last = ev
	line, err := json.Marshal(ev)
	if err != nil {
		return
	}
	e.out.Write(append(line, '\n'))
}

func newServer(cfg config) *tsnet.Server {
	return &tsnet.Server{
		Dir:        cfg.Dir,
		Hostname:   cfg.Hostname,
		ControlURL: cfg.ControlURL,
		Logf:       logger.Discard,
		UserLogf:   logger.Discard,
	}
}

func run(ctx context.Context, cfg config, out io.Writer) error {
	emit := &emitter{out: out}
	emit.send(event{State: "starting"})
	defer emit.send(event{State: "stopped"})

	if cfg.ListenLocal != "" {
		return runLocal(ctx, cfg, emit)
	}

	srv := newServer(cfg)
	defer srv.Close()
	if err := srv.Start(); err != nil {
		emit.send(event{State: "error", Code: "start-failed"})
		return err
	}
	lc, err := srv.LocalClient()
	if err != nil {
		emit.send(event{State: "error", Code: "start-failed"})
		return err
	}
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", cfg.Port))
	if err != nil {
		emit.send(event{State: "error", Code: "listen-failed"})
		return err
	}
	go serve(ctx, ln, cfg.Target)

	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		emit.send(event{State: "error", Code: "watch-failed"})
		return err
	}
	defer watcher.Close()
	for {
		n, err := watcher.Next()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			emit.send(event{State: "error", Code: "watch-failed"})
			return err
		}
		if n.BrowseToURL != nil && *n.BrowseToURL != "" {
			emit.send(event{State: "needs-login", AuthURL: *n.BrowseToURL})
		}
		if n.State != nil && *n.State == ipn.Running {
			emit.send(runningEvent(ctx, srv))
		}
	}
}

func runningEvent(ctx context.Context, srv *tsnet.Server) event {
	ev := event{State: "running"}
	if ip4, _ := srv.TailscaleIPs(); ip4.IsValid() {
		ev.IP = ip4.String()
	}
	if lc, err := srv.LocalClient(); err == nil {
		if st, err := lc.StatusWithoutPeers(ctx); err == nil && st.Self != nil {
			ev.DNSName = strings.TrimSuffix(st.Self.DNSName, ".")
		}
	}
	return ev
}

func runLocal(ctx context.Context, cfg config, emit *emitter) error {
	ln, err := net.Listen("tcp", cfg.ListenLocal)
	if err != nil {
		emit.send(event{State: "error", Code: "listen-failed"})
		return err
	}
	go serve(ctx, ln, cfg.Target)
	host, _, _ := net.SplitHostPort(ln.Addr().String())
	emit.send(event{State: "running", IP: host, DNSName: ln.Addr().String()})
	<-ctx.Done()
	return nil
}

func serve(ctx context.Context, ln net.Listener, target string) {
	context.AfterFunc(ctx, func() { ln.Close() })
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go forward(conn, target)
	}
}

func forward(client net.Conn, target string) {
	defer client.Close()
	upstream, err := net.DialTimeout("tcp", target, dialTimeout)
	if err != nil {
		return
	}
	defer upstream.Close()
	if _, err := io.WriteString(upstream, proxyHeader(client.RemoteAddr(), client.LocalAddr())); err != nil {
		return
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		io.Copy(upstream, client)
		upstream.Close()
	})
	wg.Go(func() {
		io.Copy(client, upstream)
		client.Close()
	})
	wg.Wait()
}

func proxyHeader(src, dst net.Addr) string {
	srcHost, srcPort, _ := net.SplitHostPort(src.String())
	dstHost, dstPort, _ := net.SplitHostPort(dst.String())
	family := "TCP4"
	if ip := net.ParseIP(srcHost); ip == nil || ip.To4() == nil {
		family = "TCP6"
	}
	return fmt.Sprintf("PROXY %s %s %s %s %s\r\n", family, srcHost, dstHost, srcPort, dstPort)
}

func logout(ctx context.Context, cfg config) error {
	srv := newServer(cfg)
	defer srv.Close()
	if err := srv.Start(); err != nil {
		return err
	}
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}
	return lc.Logout(ctx)
}

func exitWhenStdinCloses(cancel context.CancelFunc) {
	io.Copy(io.Discard, os.Stdin)
	cancel()
}

func main() {
	var cfg config
	showVersion := flag.Bool("version", false, "print the version and exit")
	doLogout := flag.Bool("logout", false, "log the node out and exit")
	flag.StringVar(&cfg.Dir, "dir", "", "state folder")
	flag.StringVar(&cfg.Hostname, "hostname", "ostia", "tailnet node name")
	flag.IntVar(&cfg.Port, "port", 0, "tailnet port to listen on")
	flag.StringVar(&cfg.Target, "target", "", "loopback address to forward connections to")
	flag.StringVar(&cfg.ListenLocal, "listen-local", "", "listen on this local address instead of the tailnet")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if *doLogout {
		if cfg.Dir == "" {
			fmt.Fprintln(os.Stderr, "ostia-tsnet: --logout needs --dir")
			os.Exit(2)
		}
		if err := logout(ctx, cfg); err != nil {
			fmt.Fprintln(os.Stderr, "ostia-tsnet: logout:", err)
			os.Exit(1)
		}
		return
	}

	if (cfg.Dir == "" && cfg.ListenLocal == "") || cfg.Port <= 0 || cfg.Target == "" {
		fmt.Fprintln(os.Stderr, "ostia-tsnet: needs --dir, --port and --target")
		os.Exit(2)
	}
	go exitWhenStdinCloses(cancel)
	if err := run(ctx, cfg, os.Stdout); err != nil && !errors.Is(err, context.Canceled) {
		os.Exit(1)
	}
}
