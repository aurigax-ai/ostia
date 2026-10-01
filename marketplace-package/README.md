# Pine extensions

A marketplace for [Pine](https://github.com/aurigax-ai/pine): extensions that are not built into the app.

## Use it

In Pine, open Settings → Extensions → Marketplaces, type `aurigax-ai/pine-extensions` and press Add.
Pick an extension and press Install. Pine asks you to approve it before it runs.

## What is here

| Extension | What it does | Needs |
|---|---|---|
| `model-runtime` | A local model-runtime as Pine's assistant: chat, prompt help, completions, model load and unload | a model-runtime listening on `$XDG_RUNTIME_DIR/model-runtime.sock` |

## Layout

| Path | What it is |
|---|---|
| `src/extensions/<id>/` | An extension's source: `pine.json`, `main.ts`, its modules and their tests |
| `extensions/<id>/` | What Pine installs: `pine.json` and one bundled, unminified `main.js`, built from the source and committed, because Pine copies files and never runs a build |
| `pine-marketplace.json` | The folders Pine offers. `extensions` are shown in Settings; `unlisted` ones are installed only by typing their install code |
| `test/fixtures/tools/` | Stand-ins for the command-line tools some extensions wrap, with captured output, used by the tests |

## Build

It needs Node 20 or newer and pnpm. The extensions are written against the
[Pine extension SDK](https://www.npmjs.com/package/@aurigax-ai/pine-extension-sdk), an ordinary
dependency.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build        # bundles each src/extensions/<id>/main.ts into extensions/<id>/main.js
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
