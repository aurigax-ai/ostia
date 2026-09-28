# pine

A terminal-first desktop workspace for running shells and AI coding agents side by side. It has
Warp-style command blocks, split panes, a Monaco editor, browser panes an agent can drive, and a
`pine` CLI that agents use to control the app. It is built with Electron, React and TypeScript,
and targets Linux first. Product intent and status are in [`PRODUCT.md`](PRODUCT.md).

## Install for daily use

```bash
pnpm install
pnpm install:local
```

`install:local` packages the app with electron-builder, copies it to `~/.local/share/pine/app`,
and adds a desktop launcher at `~/.local/share/applications/pine.desktop`. Run it again to update.

## Develop

```bash
pnpm install
pnpm rebuild      # rebuild node-pty for Electron's ABI (after install or an Electron bump)
pnpm dev          # run with HMR
pnpm typecheck
pnpm lint
pnpm test         # vitest: main/shared (node) + renderer (jsdom)
pnpm build && pnpm test:e2e   # Playwright against the built app
```

Without `pnpm rebuild`, terminals stay disabled and main logs `node-pty unavailable`.

## Docs

- [`CLAUDE.md`](CLAUDE.md): commands, invariants, known pitfalls, and testing rules. Read this
  before changing code.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): processes, modules, IPC, control plane,
  gateway, session restore.
- [`docs/DESIGN.md`](docs/DESIGN.md): tokens, themes, type, layout, component rules.
