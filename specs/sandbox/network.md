# Sandbox: network and ports

Status: cases approved 2026-09-30 at 0e21cd1

Intent: a sandboxed workspace reaches only allowed hosts, new hosts are added only by the human
answering a prompt, and a server inside it is reachable from the host only once the human
approves exposing its port. Back to [the index](index.md).

## Decisions
- **SBX-D12** Network is denied by default. The allowed set is the global `sandbox.allowedDomains`
  (seeded with `api.anthropic.com`, `api.openai.com`, `chatgpt.com`, `github.com`,
  `*.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `crates.io`,
  `static.crates.io`), plus the workspace's `domains`, plus its "until restart" grants. Changes
  apply to running sandboxes without a restart. Why: the human chose deny-all plus a global list,
  and srt's proxy reads the lists on every request. Governs: srt network.allowedDomains,
  settings.json#sandbox.allowedDomains.
- **SBX-D13** A sandboxed agent asks for a host with `pine sandbox request-domain <host>`. That
  raises a card with three answers: This workspace (stored), Until restart (memory), Deny. The
  host must be a hostname or `*.suffix`, optionally with `:port`; a bare `*`, IP literals and
  `localhost` are refused before any card. The verb exists only for panes in a sandboxed
  workspace. Why: this is the agent's claim path. Governs: pine sandbox request-domain,
  sandbox.request-domain socket method.
- **SBX-D14** A connection the proxy blocks raises the same card on its own, once per workspace
  and host while it's pending. After a Deny, that host raises no card again until the app
  restarts. The workspace's Sandbox view lists blocked attempts (host, time, count) with an
  Allow button. Why: the human wants every block to be visible and answerable. Governs: srt
  violation handling, Sandbox view blocked-attempts list.
- **SBX-D15** On Linux, `pine sandbox expose <port>` or the human's Expose button in the Sandbox
  view raises a card. On approval, main forwards host `127.0.0.1:<port>` to the same port inside
  the sandbox. The port must be 1024–65535 and free on the host. An exposure lives in memory and
  ends when the human clicks Unexpose, the workspace closes or the app quits. Why: the sandbox
  has no network of its own, so a server inside it is unreachable until it's bridged. Governs:
  pine sandbox expose on Linux, sandbox.expose socket method, port forwarder.
- **SBX-D16** On macOS, sandboxed shells may bind loopback ports directly (Seatbelt can't change
  that rule while the shell runs). Expose isn't shown, and `pine sandbox expose` exits 0 saying
  forwarding isn't needed on macOS. Why: parity with Linux would mean restarting the shell for
  each port. Governs: srt network.allowLocalBinding on macOS, pine sandbox expose on macOS.

- **SBX-D23** A connection to a host that isn't allowed is held (through srt's ask callback) while
  a card asks the human: This workspace, Until restart, or Deny. On approval the held connection
  goes through; on Deny or the card's timeout it fails with a sandbox reason. Connections to the
  same host while the card is pending share it. After a Deny, that host is refused with no card
  until the app restarts, and the workspace's Network tab lists recent refusals with an Allow
  button. Why: the human wants every block to be a prompt they can answer, and a held connection
  means the agent doesn't have to retry. Governs: srt violation handling, Sandbox view
  blocked-attempts list. Supersedes: SBX-D14.
- **SBX-D24** The workspace's Ports tab is the port manager. It lists every listener in the
  workspace, sandboxed ones included (on Linux read from each sandboxed process's own network
  namespace, since the host's `/proc/net/tcp` doesn't show them), with its process, port and
  exposed state, and offers Expose, Unexpose and Open. `ports.policy` decides what happens when
  a new listener appears in a sandboxed Linux workspace: `ask` (card; the default), `allow` (expose
  it automatically), or `deny` (never, no card). An agent can still ask with `pine sandbox
  expose`. Why: the human wants exposing a port to be easy and governed by a setting. Governs:
  Ports tab, ports.policy, listener detection.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| SBX-C35 | SBX-D12 | expected | Given a sandboxed pane, when it runs `curl https://api.github.com` and `curl https://example.com`, then the first succeeds and the second is blocked |
| SBX-C36 | SBX-D12 | expected | Given a running sandboxed pane, when the human adds `example.com` in Settings → Sandbox, then the next `curl https://example.com` in that pane succeeds without a restart |
| SBX-C37 | SBX-D12 | unexpected | Given an allowed host whose DNS resolves to 127.0.0.1 or a LAN address of this machine, when the pane connects, then it is blocked |
| SBX-C38 | SBX-D13 | expected | Given a sandboxed agent, when it runs `pine sandbox request-domain example.com` and the human answers This workspace, then the domain is stored for that workspace and connections succeed |
| SBX-C39 | SBX-D13 | expected | Given the human answers Until restart, when the app restarts, then `example.com` is blocked again |
| SBX-C40 | SBX-D13 | unexpected | Given a sandboxed agent, when it requests `*`, `127.0.0.1`, `localhost` or `exa mple.com`, then it is refused without a card |
| SBX-C41 | SBX-D13 | unexpected | Given a pane in an unsandboxed workspace, when it runs `pine sandbox request-domain example.com`, then it exits non-zero saying the workspace isn't sandboxed |
| SBX-C42 | SBX-D23 | expected | Given a sandboxed pane runs `curl https://example.com`, when the card appears and the human answers This workspace, then the same curl completes without a retry |
| SBX-C43 | SBX-D23 | unexpected | Given a pending card for `example.com`, when 20 more connections to it start, then there is still one card, and all of them follow its answer |
| SBX-C44 | SBX-D23 | unexpected | Given the human denied `example.com` (or the card timed out), when the pane connects again, then it fails at once with no card, and the Network tab's Allow button still works |
| SBX-C45 | SBX-D15 | expected | Given a server on :3000 inside a sandboxed Linux pane, when the agent runs `pine sandbox expose 3000` and the human approves, then `curl http://127.0.0.1:3000` on the host reaches it |
| SBX-C46 | SBX-D15 | unexpected | Given host port 3000 is already in use, when expose 3000 is approved, then it fails with "port in use" and nothing is forwarded |
| SBX-C47 | SBX-D15 | unexpected | Given an exposed port, when the workspace closes or the app quits, then the host port is released |
| SBX-C48 | SBX-D15 | unexpected | Given a sandboxed agent, when it requests expose 80, 0, 70000 or `abc`, then it is refused without a card |
| SBX-C63 | SBX-D24 | expected | Given a sandboxed Linux workspace with `ports.policy: ask`, when a process starts listening on 5173, then the Ports tab lists it with its process name and a card offers to expose it |
| SBX-C64 | SBX-D24 | expected | Given `ports.policy: allow`, when a sandboxed process starts listening on 5173, then it is exposed with no card and the Ports tab shows it exposed |
| SBX-C65 | SBX-D24 | unexpected | Given `ports.policy: deny`, when a sandboxed process listens, then no card appears, nothing is exposed, and the human's Expose button still works |
| SBX-C66 | SBX-D24 | unexpected | Given an exposed port, when its process exits, then the Ports tab shows it gone and the host port is released |
| SBX-C49 | SBX-D16 | expected | Given macOS and a sandboxed pane serving :3000, when the host runs `curl http://127.0.0.1:3000`, then it connects, the Sandbox view has no Expose button, and `pine sandbox expose 3000` exits 0 with the notice |
| SBX-C58 | SBX-D16 | unexpected | Given macOS and a sandboxed pane, when it tries to listen on the LAN address or 0.0.0.0, then the bind is denied and only loopback works |

## Open
