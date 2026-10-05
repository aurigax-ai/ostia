# Ostia extension SDK

Write extensions for [Ostia](https://github.com/aurigax-ai/ostia): the client library and its types,
JSON Schemas for the manifest files, a generator for a new extension project, and a command that
checks an extension the way Ostia does.

An extension is a folder with a `pine.json` manifest and, usually, a `main.js` that Ostia starts as
its own process. The process talks to Ostia over a local socket; this SDK wraps that protocol.
The full contract is in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Start a new extension

```sh
pnpm dlx @aurigax-ai/ostia-extension-sdk create weather
cd weather
pnpm install
pnpm validate     # builds dist/weather and checks it the way Pine will
```

`create <id> [folder]` writes a small TypeScript project: a `pine.json` with your id, one command in
`src/main.ts`, a build that bundles it into a single `main.js`, and this SDK as a dev dependency.
The id is 2 to 40 lowercase letters, digits or dashes; it becomes the `ostia <id> ...` command.

`dist/weather` is the extension. To try it, copy that folder to
`~/.config/ostia/extensions/weather`; Ostia notices it within a moment and asks you to approve it.
Then run `ostia weather greet you` in a pane, or "Weather: Greet" from the palette.

The project translates itself: `locales/zh-Hant.json` holds its manifest strings and messages in
Traditional Chinese, `locales/en.json` its English messages, and `src/main.ts` answers in the
caller's language with `createTranslator()`. See "Translations" in
[docs/EXTENSIONS.md](docs/EXTENSIONS.md).

Ostia never runs a build, a package manager or a script from an extension, so ship one bundled
`main.js`, as the generated `build.mjs` does.

## Add it to an existing project

```sh
pnpm add -D @aurigax-ai/ostia-extension-sdk
```

The package is built: there is no install script to approve. It needs Node 20 or newer.

## What is in the package

| Import | What it is |
|---|---|
| `@aurigax-ai/ostia-extension-sdk` | `connect()` and the `OstiaExtension` API (`PineExtension` is the same type under its old name): commands, events, sidebar items, pane chips, settings, secrets, notifications, panels, diffs, terminals, the human's language, `createTranslator`, `runTool`, `startPanelServer`, `onShutdown` |
| `@aurigax-ai/ostia-extension-sdk/panel` | For the page inside a panel: `call`, `onChange`, `context`, `h`, `icon`, panel sizes |
| `@aurigax-ai/ostia-extension-sdk/splitter` | A resizable split for panel pages |
| `@aurigax-ai/ostia-extension-sdk/panel.css` | Base panel styles on Ostia's theme variables |
| `@aurigax-ai/ostia-extension-sdk/assist` | The engine behind Ostia's assistant. Give `runAssistExtension` a `ProviderCatalog` to serve chat, completions and prompt help from your own model provider. Needs `ai`, `zod`, `@ai-sdk-tool/parser` and `undici` installed |
| `schemas/ostia.schema.json` | JSON Schema for the extension manifest (`ostia.json` or `pine.json`) |
| `schemas/ostia-marketplace.schema.json` | JSON Schema for a marketplace manifest (`ostia-marketplace.json` or `pine-marketplace.json`) |

`schemas/pine.schema.json` and `schemas/pine-marketplace.schema.json` are the same files under
their old names, so manifests that point at them keep working.

Point your editor at the schema from the manifest:

```json
{ "$schema": "./node_modules/@aurigax-ai/ostia-extension-sdk/schemas/ostia.schema.json" }
```

The schema catches shape mistakes while you type. `ostia-extension validate` is the authority: it
runs the same checks Ostia runs when it loads the extension.

## The old names

This package was published as `@aurigax-ai/pine-extension-sdk` before the app was renamed to
Ostia. That package is deprecated; install this one instead. Everything else keeps working under
its old name too:

- The `pine-extension` command is the same program as `ostia-extension`.
- The app reads an extension manifest named `ostia.json` or `pine.json` (`ostia.json` wins when a
  folder has both) and a marketplace manifest named `ostia-marketplace.json` or
  `pine-marketplace.json`. Versions before the rename read only the `pine` names, so keep those
  while you want them to load your extension. The template uses `pine.json` for that reason.
- `package.json` has `pineExtensionApi` next to `ostiaExtensionApi`, with the same value.

## Check an extension or a marketplace

```sh
pnpm exec ostia-extension validate dist/weather     # one extension folder
pnpm exec ostia-extension validate .                # a marketplace: a folder with pine-marketplace.json
pnpm exec ostia-extension unlist extensions/weather # hide it in Pine: installable only by the printed code
```

It exits 0 when Ostia would accept it and prints one line per problem otherwise. For an extension it
also checks what a marketplace install requires: regular files only, at most 8000 files and
50 MiB. Run it on the folder you publish, not on a project folder that holds `node_modules`.

## Publish

A marketplace is a git repository with a `pine-marketplace.json` that lists extension folders.
Commit your built folder to one, and people add the repository in Ostia under Settings →
Extensions → Marketplaces. See "Marketplaces" in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Source

`dist/` is what you import: the SDK bundled into a few plain, unminified JavaScript files.
`src/` holds the TypeScript it was built from, at the same paths as in the Ostia repository
(`src/extensions/sdk` is the library, `src/shared` the contract types, `src/cli` and `src/main` the
`ostia-extension` command and the manifest loader it runs). It is there to read. The SDK is developed
in [the Ostia repository](https://github.com/aurigax-ai/ostia) and published from it on every release,
so the SDK and the app cannot drift apart. Report problems in that repository's issues.

## Versions

Two numbers matter:

- **The extension API version** (`EXTENSION_API_VERSION`, `ostiaExtensionApi` in `package.json`,
  `api.json`): the version of the contract, `major.minor`. Put it in your manifest as `"api"`.
  A minor adds things and keeps every existing extension working; Ostia provides exactly one
  major. Ostia refuses an extension whose `api` it doesn't provide, and `connect()` refuses to
  run against an app older than the SDK it was built with.
- **The package version**: the version of Ostia this SDK was built from.

## Licence

MIT
