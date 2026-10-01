<p align="center">
  <img src="resources/icon.png" width="88" height="88" alt="Pine icon">
</p>

<h1 align="center">Pine</h1>

<p align="center">One workspace for you and every coding agent you run.</p>

<p align="center">
  <a href="https://aurigax-ai.github.io/pine-website/">Website</a>
  &nbsp;&nbsp;
  <a href="https://github.com/aurigax-ai/pine/releases/latest">Download</a>
  &nbsp;&nbsp;
  <a href="sdk-package/docs/EXTENSIONS.md">Write an extension</a>
</p>

![Pine with six projects in the sidebar, an agent session and the diff of its change](.github/readme/hero.webp)

Pine is a terminal for Linux where Claude Code, Codex and your own shell share panes, a browser,
diffs and approvals. It ships no agent of its own: any CLI that can run a shell command works.

## What it does

- **Shows which agent needs you.** Each pane reports working, waiting or done through the agent's
  own hooks. The sidebar and the notification list show it for every project at once.
- **Gives agents the same app you use.** Every pane has a `pine` command. `pine process run` is a
  tab you can watch, `pine browse` drives a browser pane, `pine git open` opens a diff.
- **Asks before an agent goes further.** A call that needs a permission the pane lacks waits on a
  card. A sandboxed workspace confines its shells to the folder and a list of allowed hosts.
- **Stays a good terminal.** Command blocks, split panes and tabs, a file tree, a Monaco editor,
  and workspaces that come back with their layout and scrollback after a restart.
- **Bends to how you work.** Extensions from any git repository, sidebar sections written as JSON,
  themes, prompt chips and your own key chords.

| | |
|---|---|
| ![An agent driving the browser pane with the pine command](.github/readme/browser.webp) | ![The Git panel and a diff beside the shell](.github/readme/review.webp) |
| An agent starts a dev server, opens the page and clicks through it. | Changed files and the diff, beside the shell. |
| ![An approval card under an agent session](.github/readme/approval.webp) | ![A sandboxed shell asking to reach a host](.github/readme/sandbox.webp) |
| A call that needs a new permission waits for you. | A sandboxed workspace asks before it reaches a new host. |

The agent sessions in these captures are scripted stand-ins running in the real app.

## Install

Pine has Linux builds for x64. Get the AppImage or the tarball from the
[latest release](https://github.com/aurigax-ai/pine/releases/latest).

```bash
chmod +x pine-*.AppImage
./pine-*.AppImage
```

## Build from source

You need Node.js and pnpm.

```bash
git clone https://github.com/aurigax-ai/pine.git
cd pine
pnpm install
pnpm install:local
```

`install:local` packages the app, copies it to `~/.local/share/pine/app`, and adds a desktop
launcher and the `pine` command in `~/.local/bin`. Run it again to update.

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

## Licence

MIT
