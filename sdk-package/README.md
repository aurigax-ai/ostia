# Pine extension SDK

Everything you need to write an extension for Pine: the client library, its types, JSON Schemas
for the manifest files, a command that checks an extension the way Pine does, and a starter
template.

An extension is a folder with a `pine.json` manifest and, usually, a `main.js` that Pine starts as
its own process. The process talks to Pine over a local socket; this SDK wraps that protocol.
The full contract is in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Install

```sh
pnpm add -D github:aurigax-ai/pine-extension-sdk
```

The package is built: there is no install script to approve. It needs Node 20 or newer.

## Start from the template

Copy [`template/`](template) and run:

```sh
pnpm install
pnpm build        # bundles src/main.ts into dist/hello/main.js and copies pine.json
pnpm validate     # checks dist/hello the way Pine will
```

`dist/hello` is the extension. To try it, copy that folder to `~/.config/pine/extensions/hello`;
Pine notices it within a moment and asks you to approve it. Then run `pine hello greet you` in a
pane, or "Hello: Greet" from the palette.

Pine never runs a build, a package manager or a script from an extension, so ship one bundled
`main.js`, as the template's `build.mjs` does.

## What is in the package

| Import | What it is |
|---|---|
| `@aurigax-ai/pine-extension-sdk` | `connect()` and the `PineExtension` API: commands, events, sidebar items, pane chips, settings, secrets, notifications, panels, diffs, terminals, `runTool`, `startPanelServer`, `onShutdown` |
| `@aurigax-ai/pine-extension-sdk/panel` | For the page inside a panel: `call`, `onChange`, `context`, `h`, `icon`, panel sizes |
| `@aurigax-ai/pine-extension-sdk/splitter` | A resizable split for panel pages |
| `@aurigax-ai/pine-extension-sdk/panel.css` | Base panel styles on Pine's theme variables |
| `@aurigax-ai/pine-extension-sdk/assist` | The engine behind Pine's assistant. Give `runAssistExtension` a `ProviderCatalog` to serve chat, completions and prompt help from your own model provider. Needs `ai`, `zod`, `@ai-sdk-tool/parser` and `undici` installed |
| `schemas/pine.schema.json` | JSON Schema for `pine.json` |
| `schemas/pine-marketplace.schema.json` | JSON Schema for a marketplace's `pine-marketplace.json` |

Point your editor at the schema from the manifest:

```json
{ "$schema": "./node_modules/@aurigax-ai/pine-extension-sdk/schemas/pine.schema.json" }
```

The schema catches shape mistakes while you type. `pine-extension validate` is the authority: it
runs the same checks Pine runs when it loads the extension.

## Check an extension or a marketplace

```sh
pnpm exec pine-extension validate dist/hello     # one extension folder
pnpm exec pine-extension validate .              # a marketplace: a folder with pine-marketplace.json
```

It exits 0 when Pine would accept it and prints one line per problem otherwise. For an extension it
also checks what a marketplace install requires: regular files only, at most 2000 files and
50 MiB. Run it on the folder you publish, not on a project folder that holds `node_modules`.

## Publish

A marketplace is a git repository with a `pine-marketplace.json` that lists extension folders.
Commit your built folder to one, and people add the repository in Pine under Settings →
Extensions → Marketplaces. See "Marketplaces" in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Versions

The SDK's version is the version of Pine it was built from. This repository holds build output;
it is generated from Pine's own source, so the SDK and the app cannot drift apart.
