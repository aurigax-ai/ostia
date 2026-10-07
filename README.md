<p align="center">
  <img src="resources/icon.png" width="88" height="88" alt="Ostia icon">
</p>

<h1 align="center">Ostia</h1>

<p align="center">One workspace for you and your coding agents.</p>

<p align="center">
  <a href="https://aurigax-ai.github.io/">Website</a>
  &nbsp;&nbsp;
  <a href="https://github.com/aurigax-ai/ostia/releases/latest">Download</a>
  &nbsp;&nbsp;
  <a href="https://www.npmjs.com/package/@aurigax-ai/ostia-extension-sdk">Write an extension</a>
</p>

![Ostia with six projects in the sidebar, an agent session and the diff of its change](.github/readme/hero.webp)

Ostia is a terminal for macOS and Linux where Claude Code, Codex and your own shell share panes, a
browser, diffs and approvals. It ships no agent of its own: any CLI that can run a shell command
works.

## What it does

- **Shows which agent needs you.** Each pane reports working, waiting or done through the agent's
  own hooks. The sidebar and the notification list show it for every project at once.
- **Gives agents the same app you use.** Every pane has an `ostia` command. `ostia process run` is a
  tab you can watch, `ostia browse` drives a browser pane, `ostia git open` opens a diff.
- **Asks before an agent goes further.** A call that needs a permission the pane lacks waits on a
  card. A sandboxed workspace confines its shells to the folder and a list of allowed hosts.
- **Stays a good terminal.** Command blocks, split panes and tabs, a file tree, a Monaco editor,
  and workspaces that come back with their layout and scrollback after a restart.
- **Bends to how you work.** Extensions from any git repository, sidebar sections written as JSON,
  themes, prompt chips, and your own key chords: several keys per command, and `terminal:` chords
  that apply only inside a terminal. Presets switch the shortcuts and text editing (for example
  Natural Text Editing from iTerm2), and you can import workspaces and layouts from cmux.

| | |
|---|---|
| ![An agent driving the browser pane with the ostia command](.github/readme/browser.webp) | ![The Git panel and a diff beside the shell](.github/readme/review.webp) |
| An agent starts a dev server, opens the page and clicks through it. | Changed files and the diff, beside the shell. |
| ![An approval card under an agent session](.github/readme/approval.webp) | ![A sandboxed shell asking to reach a host](.github/readme/sandbox.webp) |
| A call that needs a new permission waits for you. | A sandboxed workspace asks before it reaches a new host. |

The agent sessions in these captures are scripted stand-ins running in the real app.

## Install

Ostia runs on macOS 13 Ventura or later (Apple silicon) and Linux (x64). Windows is not supported.

### macOS 13 or later (Apple silicon)

```bash
brew install --cask aurigax-ai/tap/ostia
```

`brew upgrade --cask ostia` picks up new releases. Without Homebrew, download the signed and
notarized `ostia-<version>-arm64.dmg` from the
[latest release](https://github.com/aurigax-ai/ostia/releases/latest) and drag Ostia to
Applications.

The cask also links the `ostia` command into your PATH, so `ostia --help` works in any terminal.
With the dmg, run `Ostia.app/Contents/Resources/bin/ostia` directly.

### Debian and Ubuntu (x64)

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://github.com/aurigax-ai/apt/releases/download/stable/ostia.gpg | sudo tee /etc/apt/keyrings/ostia.gpg >/dev/null
echo 'deb [signed-by=/etc/apt/keyrings/ostia.gpg] https://github.com/aurigax-ai/apt/releases/download/stable ./' | sudo tee /etc/apt/sources.list.d/ostia.list
sudo apt update && sudo apt install ostia
```

`sudo apt upgrade` picks up new releases. The package adds Ostia to the app menu and the `ostia` command.

### Other Linux (x64)

Get the tarball from the
[latest release](https://github.com/aurigax-ai/ostia/releases/latest).

```bash
tar -xzf ostia-*-linux-x64.tar.gz
./ostia-*-linux-x64/ostia
```

## Build from source

You need Node.js and pnpm.

```bash
git clone https://github.com/aurigax-ai/ostia.git
cd ostia
pnpm install
pnpm install:local
```

`install:local` packages the app, copies it to `~/.local/share/ostia/app`, and adds a desktop
launcher and the `ostia` command in `~/.local/bin`. Run it again to update.

## Develop

```bash
pnpm install
pnpm rebuild      # rebuild node-pty for Electron's ABI
pnpm dev          # run with hot reload
pnpm typecheck
pnpm lint
pnpm test         # unit and component tests
pnpm build && pnpm test:e2e   # Playwright against the built app
```

Without `pnpm rebuild`, terminals stay disabled and the log says `node-pty unavailable`.

## Privacy and telemetry

Ostia sends nothing unless you turn it on. On first start it asks once, and Settings → Privacy
has two switches you can change at any time:

- **Error reports**: uncaught errors and crashes of the app, its windows and its extensions. A
  report holds the error name, a stack trace reduced to file names inside the app, the app and
  Electron versions, the operating system and the architecture.
- **Usage data**: counts only. App starts, session length, which palette commands, pane kinds and
  settings sections were used, and which extensions you installed from the official marketplace.

Reports are grouped by a random install id you can reset in Settings. They go from the main
process alone, in batches over https, to one fixed endpoint run by the developers. Never included:
terminal output, what you type, command lines, file paths or names, URLs, environment variables,
settings values, workspace names, tokens or your IP address. Detected secrets are redacted and free
text is clipped. **Show what Ostia sends** in Settings → Privacy lists the queued and last-sent
reports exactly as they go out. Turning a switch off stops sending at once and drops what was
queued.

## Licence

From 0.5.10, Ostia is licensed under the [Functional Source License, Version 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT). It is source-available, not open source.

- You may use, copy, modify and redistribute it for anything except a Competing Use, which means making Ostia available to others in a commercial product or service that substitutes for Ostia, or for another AurigaX product or service built on Ostia that existed when that version was released, or offers substantially similar functionality. Personal use, use inside your own company, and non-commercial education and research are all fine.
- Each release converts to the MIT licence two years after it is published.
- Versions up to and including 0.5.9 were released under the MIT licence and stay MIT.
