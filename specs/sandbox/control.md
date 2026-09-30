# Sandbox: Pine control plane

Status: cases approved 2026-09-30 at 0e21cd1

Intent: Pine's own features (control socket, browser, other workspaces) don't become a way around
the sandbox, and the human decides how much of Pine a sandboxed workspace can reach. Back to
[the index](index.md).

## Decisions
- **SBX-D17** Each sandboxed workspace has two control switches in its Sandbox view, and only the
  human sets them. `allWorkspaces` defaults to off: requests for `all-workspaces` from its panes
  are refused without a card. `browser` defaults to `allowlist`: `browse.*` from its panes may
  open or navigate only to hosts in the workspace's allowed set, and any other host raises the
  domain card (SBX-D13). The other choice is `unrestricted`. Why: Pine's browser and
  cross-workspace commands are outside the fence, and the human asked for this to be
  controllable. Governs: controlElevation for sandboxed panes, browse.open, browse.navigate,
  sandbox.controls.
- **SBX-D18** Inside the sandbox, Unix sockets other than Pine's control socket are unreachable.
  On Linux, srt's socket blocking is off (it can't allow one path), and `$XDG_RUNTIME_DIR` is
  read-denied except for `PINE_SOCKET`. On macOS, `allowUnixSockets` lists only `PINE_SOCKET`.
  Why: the session bus, Docker and ssh-agent sockets are escape routes, and `pine` must still
  work. Governs: srt network.allowAllUnixSockets, srt network.allowUnixSockets, denyRead of
  XDG_RUNTIME_DIR.

## Cases
| ID | Covers | Kind | Case |
|---|---|---|---|
| SBX-C50 | SBX-D17 | expected | Given a sandboxed workspace with default controls, when its agent runs a command needing `all-workspaces`, then it is refused with a sandbox reason and no card is shown |
| SBX-C51 | SBX-D17 | expected | Given the human turns `allWorkspaces` on, when the agent runs the same command, then the normal capability card is shown |
| SBX-C52 | SBX-D17 | expected | Given `browser: allowlist`, when the agent runs `pine browse open https://example.com` for a host not allowed, then the browser doesn't navigate and a domain card appears; after This workspace, the retry opens it |
| SBX-C53 | SBX-D17 | unexpected | Given `browser: allowlist`, when an allowed page redirects or the agent navigates to a host not allowed, then the navigation is blocked |
| SBX-C54 | SBX-D17 | unexpected | Given an agent, when it tries to change `allWorkspaces` or `browser` through any socket method, CLI verb or `settings.set`, then it is refused |
| SBX-C55 | SBX-D18 | expected | Given a sandboxed Linux pane, when it connects to the session bus socket or `/var/run/docker.sock`, then it fails, and `pine whoami` still works |
| SBX-C56 | SBX-D18 | unexpected | Given `SSH_AUTH_SOCK` inherited from the host, when a sandboxed pane runs `ssh-add -l`, then it can't reach the agent |

## Open
