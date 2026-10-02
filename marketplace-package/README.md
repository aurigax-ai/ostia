# Pine extensions

A marketplace for [Pine](https://github.com/aurigax-ai/pine): extensions that are not built into the app.

## Use it

In Pine, open Settings → Extensions → Marketplaces, type `aurigax-ai/pine-extensions` and press Add.
Pick an extension and press Install. Pine asks you to approve it before it runs.

## What is here

| Extension | What it does | Needs |
|---|---|---|
| `lsp-typescript` | TypeScript and JavaScript in the editor, with `typescript-language-server` and TypeScript inside the extension | nothing |
| `lsp-pyright` | Python in the editor, with Pyright inside the extension | nothing |
| `lsp-yaml` | YAML in the editor, with `yaml-language-server` inside the extension | nothing |
| `lsp-bash` | Shell scripts in the editor, with `bash-language-server` inside the extension | `shellcheck` on `PATH` for linting |
| `lsp-rust-analyzer` | Rust in the editor | `rust-analyzer` on `PATH`, or Pine downloads the pinned release |
| `lsp-clangd` | C and C++ in the editor | `clangd` on `PATH`, or Pine downloads the pinned release |
| `lsp-lua` | Lua in the editor | `lua-language-server` on `PATH`, or Pine downloads the pinned release |
| `lsp-marksman` | Markdown in the editor | `marksman` on `PATH`, or Pine downloads the pinned release |
| `lsp-gopls` | Go in the editor | Go, to install the pinned `gopls` when none is on `PATH` |
| `model-runtime` | A local model-runtime as one more provider for Pine's assistant, with model load and unload | a model-runtime listening on `$XDG_RUNTIME_DIR/model-runtime.sock` |

## Layout

| Path | What it is |
|---|---|
| `src/extensions/<id>/` | An extension's source: `pine.json`, its translations under `locales/`, and when it runs a process `main.ts`, its modules and their tests. One with a panel adds `panel.html`, `panel.css` and `panel.ts`; a language extension that ships its server names the npm packages in `vendor.json` |
| `extensions/<id>/` | What Pine installs: `pine.json`, `locales/`, one bundled, unminified `main.js`, the panel's files, and under `server/` the vendored packages copied unchanged from `node_modules`. Built from the source and committed, because Pine copies files and never runs a build |
| `build.mjs`, `build-extension.mjs` | The build: `build-extension.mjs` builds one extension folder and is the same file Pine builds its own extensions with |
| `pine-marketplace.json` | The folders Pine offers. `extensions` are shown in Settings; `unlisted` ones are installed only by typing their install code |
| `test/fixtures/tools/` | Stand-ins for the command-line tools some extensions wrap, with captured output, used by the tests |

## Build

It needs Node 20 or newer and pnpm. The extensions are written against the
[Pine extension SDK](https://www.npmjs.com/package/@aurigax-ai/pine-extension-sdk), an ordinary
dependency. The language servers that ship inside an extension are dependencies too, each pinned
to one exact version, so `extensions/` changes only when a version here does.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build        # builds each src/extensions/<id> into extensions/<id>
pnpm validate     # checks the marketplace and every extension the way Pine will
```

CI runs the same steps and fails when `extensions/` is not what the source builds.

To try a build, copy `extensions/<id>` to `~/.config/pine/extensions/<id>`; Pine notices it within
a moment and asks you to approve it.

## Where changes are made

The source is developed in the [Pine repository](https://github.com/aurigax-ai/pine) under the
same paths, where it is also tested against the app. The `Sync with Pine` workflow here checks
hourly for a new Pine release, rebuilds this repository from that tag, runs the checks above and
commits the result. Send changes to the Pine repository.

## Write your own

Start from the SDK's template (`node_modules/@aurigax-ai/pine-extension-sdk/template`) and its
guide (`docs/EXTENSIONS.md` in the same package).
