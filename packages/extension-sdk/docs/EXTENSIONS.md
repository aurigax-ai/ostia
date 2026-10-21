# Writing a Ostia extension

An extension is a directory with a `ostia.json` manifest and, usually, a program Ostia starts for
you. The program talks JSON-RPC to Ostia over the same control socket the `ostia` CLI uses. That
gives it palette and CLI commands, events, sidebar status items, pane and workspace chips, typed
settings, encrypted secrets, the assist hook points (typo fix and prompt review, command
suggestions, editor completions, the Ask conversation), notifications and a panel surface. The
built-in System, SSH and Assistant, and the marketplace's Trellis, Keeper and Model runtime
(`src/extensions/`), use nothing else, so they are the reference
implementations.

If you only need to show something (a sidebar section, a panel with buttons), a
[declarative view](#declarative-views-ui-without-a-process) is one JSON file and no process.

## Where extensions live

| Location | Kind |
|---|---|
| `resources/extensions/<id>/` in the app (`out/extensions` in dev) | Built-in: pre-approved, enabled by default |
| `~/.config/ostia/extensions/<id>/` (`$XDG_CONFIG_HOME` is honored) | Yours: asks for approval on first launch |

Extensions are discovered at startup, and Ostia watches your extensions directory while it
runs: adding, changing or removing a `ostia.json` takes effect within a moment, no restart needed.
A new extension still asks for approval first, and a changed manifest that asks for more
capabilities runs with what you approved before until you review it. A changed extension that
was running is restarted. Settings → Extensions lists every extension with its status, permissions,
settings form and an enable switch. A disabled extension has no process, no commands, no panel,
no sidebar items and no pane chips. Extensions in the Settings nav expands into one entry per
extension (its panel icon, if it has one) that scrolls to that extension's block; core code links
there with `openSettings('extensions', { extension: id })` or `openSettings('extensions/<id>')`, and the
Settings search box finds an extension by its name, a setting title or a setting key.

## Marketplaces

A marketplace is a git repository that lists extensions. The human adds one in Settings →
Extensions → Marketplaces by typing `owner/repo` (GitHub), an `https://` or `ssh` git URL, or an
absolute folder path for one you are still writing. Ostia clones it with the system `git` (shallow,
no submodules, symlinks off) into its data folder and shows what it offers.

The repository has a `ostia-marketplace.json` at its root:

```json
{
  "name": "Acme extensions",
  "description": "Tools from Acme",
  "extensions": ["extensions/weather", "extensions/timer"]
}
```

| Field | Rules |
|---|---|
| `name` | 1 to 80 characters |
| `description` | Optional |
| `extensions` | Folder paths inside the repository. Each folder is one extension with its own `ostia.json` |
| `unlisted` | Optional. `{ "path", "code" }` entries: extensions the marketplace holds but Settings does not show. `code` is 26 characters of `a-z` and `2-7`, unique in the file. `extensions` and `unlisted` together hold at most 200 |

### Unlisted extensions

An unlisted extension is one Ostia does not show. Main never sends it to the window: the card only
gets an "install code" field when the marketplace has any. The human types the code; an exact
match installs the extension the usual way (copied, then waiting for approval), and from then on
it is shown in that marketplace's card like any other, with Update when a refresh brings a new
version. A wrong code answers the same whether or not anything is unlisted under it, and a broken
unlisted entry is not named under "Entries that could not be offered".

```sh
pnpm exec ostia-extension unlist extensions/timer     # run in the marketplace folder
```

moves the path from `extensions` to `unlisted`, generates its code and prints it. Give the code to
whoever should install it. To list it again, move the path back by hand.

Unlisted is not private. The code and the extension's files are in the repository, so anyone who
can read the repository can read both; it only keeps an entry out of Ostia's Settings. Use a
private repository (an `ssh` URL) for extensions that must not be public.

Rules for a listed extension:

- It is installed by copying its folder as it is in the repository, so commit the built files
  (`main.js` bundled, panel HTML). Ostia never runs `npm install`, a build or any script from it.
- Regular files and folders only: a symlink or special file refuses the install. At most 8000 files
  and 50 MiB.
- An entry with a broken `ostia.json`, a missing folder or an id another entry already uses is
  listed under "Entries that could not be offered" and the rest still work.

Install copies the folder to `~/.config/ostia/extensions/<id>/`, where it is an ordinary user
extension: it waits for the approval dialog before anything runs, and any approval an earlier
extension with that id had is dropped first. Refresh re-downloads the marketplace; when the listed
version differs from the installed one the row offers Update, which replaces the files and keeps
the approval (new capabilities still wait for review). Uninstall, on the installed extension's row,
deletes the folder, its approval and its saved secrets; its settings stay in `settings.json`. An id
that a built-in uses, or that you installed by hand or from another marketplace, is never
overwritten. Removing a marketplace leaves its installed extensions in place.

There is no `ostia` CLI verb or socket method for any of this: only the human adds marketplaces and
installs, updates or uninstalls, from Settings.

## Manifest (`ostia.json`)

The manifest is `ostia.json`; a marketplace's is `ostia-marketplace.json`.

```json
{
  "id": "dev-ports",
  "name": "Ports",
  "version": "0.1.0",
  "description": "Shows listening dev servers per workspace.",
  "capabilities": ["read-board", "notify"],
  "main": "main.js",
  "contributes": {
    "commands": [
      { "id": "open", "title": "Open Ports", "category": "App" },
      { "id": "find", "title": "Find a Port", "usage": "find <port>", "argument": "Port number" },
      { "id": "ls", "title": "List ports", "usage": "ls [--all]", "palette": false,
        "capabilities": ["read-board"] },
      { "id": "note", "title": "Attach a note", "usage": "note <port>", "palette": false,
        "stdin": true },
      { "id": "kill", "title": "Stop a dev server", "usage": "kill <port>", "palette": false,
        "interactive": true }
    ],
    "sidebarItems": true,
    "panel": { "title": "Ports", "icon": "server", "entry": "url" },
    "workspaceChips": [{ "id": "ports", "title": "Listening ports" }],
    "settings": {
      "interval": { "type": "number", "title": "Scan interval", "default": 3,
        "minimum": 1, "maximum": 60, "unit": "seconds",
        "description": "Time between scans while {product} is focused" },
      "showSsh": { "type": "boolean", "title": "Show ssh host", "default": true,
        "description": "Show the host of a foreground ssh" },
      "sort": { "type": "enum", "title": "Sort order", "values": ["port", "name"],
        "valueTitles": { "port": "By port", "name": "By name" }, "default": "port",
        "description": "Order of the items" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes, 2–40 chars. It is the CLI word (`ostia dev-ports ls`) unless `contributes.verb` is set: an extension with a `verb` is reached only by that verb, and `ostia <id> <command>` then answers with its usage and runs nothing. The id is always the command prefix (`dev-ports.open`). `git` and `ports` are taken: Git and Ports are part of Ostia, and a manifest with one of those ids is refused. |
| `name`, `version`, `description` | Shown in Settings and the approval dialog. |
| `locales` | Optional. Up to 32 language tags (`"zh-Hant"`, `"fr"`) you ship a catalog for, each read from `locales/<tag>.json` in the extension. See "Translations" below. |
| `capabilities` | What the extension process may do through Ostia. It gets this list intersected with what the user approved. Names are Ostia's capability names (`contract/capabilities.ts`). |
| `main` | Path inside the extension dir. `.js`/`.cjs`/`.mjs` run with Ostia's own Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`), so no system Node is needed; anything else is executed directly (any language). cwd is the extension dir. Required if you contribute commands, sidebar items or a `url` panel. |
| `contributes.commands[]` | `id` (no dots), `title`, optional `category`, `usage` (shown in `ostia docs` / `ostia ext list`), `palette` (default `true`; `false` = CLI/agents only), `stdin` (CLI pipes stdin to you), `needsPlaybook` (API 7.4, built-ins only: the palette lists the command only while the human has the playbook with your extension's id on; the command itself refuses without it), `interactive` (the command waits on the human, usually through `ext.confirm`: Ostia waits up to 10 min for your reply instead of 30 s), `argument` (a label, 80 chars: picking the command in the palette asks the human for one value, shown with this label, and you get it as `args.argv[0]`, the same shape as `ostia <id> <command> <value>`; without `argument` palette runs get `null` args), `capabilities` (what the **caller** must hold; checked by Ostia before your process sees the call). |
| `contributes.sidebarItems` | `true` if you call `ext.setSidebarItem`. Such extensions start with the window instead of on first use, and so do extensions that declare `paneChips` or `workspaceChips`. A built-in extension with sidebar items and no chips starts on first use, and with the window only after it asked to with `ext.startWithWindow(true)`. |
| `contributes.panel` | `title`, optional `icon`, and `entry`: a `.html` path inside the extension, or `"url"` to hand Ostia a loopback URL at runtime. (API 7.0) Optional `toolbar: {tabs?, actions?}`: up to 6 `tabs` `{id, title}` and 6 `actions` `{id, title, icon}` (`id` matches `^[a-z][a-z0-9-]{0,39}$`, `icon` one of the extension icons) that Ostia draws in the panel's toolbar row; see [Panel toolbar](#panel-toolbar). |
| `contributes.paneChips` | Up to 8 `{id, title}`. Each is a slot for a short value you put on a pane's header with `ext.setPaneChip` (for example a venv or a test count). `title` names it in tooltips and in Settings → Prompt: the human can also place your chip in the Ostia prompt's chip row (`terminal.prompt.chips` id `<extId>.<chip>`), where it shows the same value. Needs `main`. |
| `contributes.workspaceChips` | Up to 8 `{id, title}`, like `paneChips` but for a value that describes a whole workspace (for example its repository's branch and changes). You set it with `ext.setWorkspaceChip`; the top bar shows the chips of the active workspace. The Ostia prompt can show it too (same `<extId>.<chip>` id): a pane's prompt shows its own pane chip if there is one, otherwise its workspace's. Needs `main`. |
| `api` | Required. The extension API version you wrote against, `major.minor` (`"1.0"`). Ostia loads the extension only when it provides that major and at least that minor; otherwise the manifest is refused with `needs extension API X; this Ostia provides Y`, in the log, in `ostia-extension validate` and under a marketplace's "Entries that could not be offered". See "API version" |
| `category` | Optional, one of `ai`, `scm`, `tools`, `themes`, `langpack`, `completions`, `languages`, `other` (the default). Settings → Extensions and the marketplace show it as a badge. Anything else refuses the manifest |
| `contributes.languages` | Up to 8 language packs, each `{id, label, path}`: `id` is a language tag (`fr`, `zh-Hant`), `label` the name shown in Settings → Language, `path` a `.json` file inside the extension. The file is a nested object of strings shaped like Ostia's English catalog (`src/shared/app/dict.ts`, `en`): translate the keys you want, anything missing stays English, and keys English doesn't have are ignored. Keep `{placeholders}` as they are. No `main` needed. Main reads the file (no symlinks, ≤ 1 MiB, strings ≤ 4000 characters) only while the extension is enabled; disabling it puts the interface back in English. The first enabled extension to provide a language wins, and none can replace English |
| `contributes.settings` | Up to 32 keys (`[A-Za-z][A-Za-z0-9_-]*`), each `{type, default, description}` with `type` one of `string` (≤ 1000 chars), `number`, `boolean`, `enum` (plus `values: string[]`). The default must match the type. Optional: `title`, the label Settings shows (sentence case, ≤ 80 chars, no control characters; without it Settings humanizes the key, `intervalSeconds` → "Interval seconds"); for `enum`, `valueTitles: {<value>: <label>}` for the options (keys must be in `values`); for `number`, `minimum` and `maximum` (main refuses values outside them, and the default must be inside) and `unit` (`seconds` or `per-minute`), which Settings shows after the description as "(1 to 60 seconds)", so leave the range out of the description. Settings shows the raw key in small mono type next to the title for people who edit `settings.json`. Titles, descriptions and value titles may say `{product}`, which Settings replaces with the product name; never write the product name itself. Main checks all of it when it loads the manifest. Manifest strings are not localized. Settings → Extensions shows a form for them (or your own page, with `contributes.settingsPage`); the human's values are stored in `settings.json` under `extensionSettings.<id>` and synced with it, so never put a secret there. |
| `contributes.settingsPage` | Optional `{title, icon?}`: gives your settings and secrets their own entry in Settings, under Extensions, instead of a form under your row in Settings → Extensions. `title` (≤ 80 chars, no control characters, may say `{product}`) names the entry and heads the page; `icon` is one of the sidebar item icon names (`kanban`, `plugs`, …; anything else refuses the manifest). The page draws the same form, so main still validates every value against `contributes.settings`. It shows only while the extension is enabled; while it is disabled the form stays under its row. Needs `contributes.settings` or `contributes.secrets`, and is refused with `contributes.assist`, whose settings live in Settings → Assistant. Your row in Settings → Extensions links to the page. Use it when your settings are many or form a whole area of their own; a few switches read better under your row. |
| `contributes.snippets[]` | Saved snippets in Warp's workflow file format (at most 64): `name`, `command` with `{{arg}}` placeholders (`{{{x}}}` is a literal `{{x}}`), optional `description`, `tags`, `arguments[{name, description, default_value}]`, `shells`, `author`, `source_url`. Data only: no `main` needed. They appear in "Snippets: Search" and `ostia snippet list` while the extension is enabled and approved; Ostia inserts one at an idle prompt only when the human picks it. |
| `contributes.completions` | A folder inside the extension holding command completion specs, one `<command>.json` per command: `{names, description, subcommands[], options[{names, description, args, isPersistent, isRepeatable}], args[{name, description, suggestions[{name, description}], template: ["filepaths" \| "folders"], isOptional, isVariadic}]}`. Data only: no `main` needed, and nothing in a spec runs. Main reads a spec when the input editor completes that command (size-capped, symlinks refused, validated); `~/.config/ostia/completions/<command>.json` wins over any extension's. The built-in `completions` extension ships about 700 specs converted from Fig's `@withfig/autocomplete` at build time (`scripts/completionSpecs.mjs`). |

| `contributes.verb` | API 3.3. Your commands' only CLI word (`[a-z][a-z0-9-]{1,19}`): with `"verb": "graph"`, `ostia graph <command>` runs your command, `ostia <id> <command>` answers with that usage and runs nothing, and `ostia docs` and `ostia ext list` show the verb. A core verb (`pane`, `bus`, …), `git`, `ports`, or another extension's id or verb is refused. |
| `contributes.secrets` | Up to 8 keys (same pattern as settings), each `{description}` and an optional `title` (same rules as a setting's). Settings → Extensions shows a password field per key; the value is stored encrypted in Ostia's data dir (never in `settings.json`, never synced) and never sent back to the renderer. Read it with `ext.getSecret`. |
| `contributes.connections` | API 4.1. 1-8 kinds of named connection the human can make for you, each `{kind, title, description?, fields, secrets?}`: `kind` matches `^[a-z][a-z0-9-]{0,39}$`; `fields` holds up to 8 keys (same pattern as settings), each `{title, description?, type: 'string' \| 'enum', enum? (enum fields only, 1-32 distinct values), default?, required?}`; `secrets` up to 4 keys, each `{title, description?}`, and a secret key may not also be a field. Your details pane in Settings shows a Connections list where the human adds, edits and removes connections by name (`^[a-z][a-z0-9-]{0,39}$`, at most 32): field values (at most 2048 characters) are kept by Ostia in a file of its own, never synced; secrets are stored encrypted like `contributes.secrets` and never sent back to the renderer. Only the human makes or changes a connection; you read one with `ext.connection`, and never another extension's. |
| `contributes.assist` | Which assist points you serve: any of `input`, `command`, `completion`, `terminal`, `chat` (see [Assist](#assist)). Needs the `assist` capability and `main`; such an extension starts with the window. |
| `contributes.iconThemes[]` | Up to 16 `{id, label, path}` file icon themes in VS Code's format (`path` is the theme JSON inside the extension). Data only: no `main` needed. See [Icon themes](#icon-themes). |
| `contributes.keymaps[]` | Up to 8 keymaps, each `{id, label, path, platform?}`: `id` lowercase letters, digits and dashes (unique in the extension), `label` (1–40 chars) the name shown in Settings → Keyboard, `path` a `.json` file inside the extension, `platform` optional `darwin` or `linux` to offer it on that platform only. Data only: no `main` and no capability needed. See [Keymaps](#keymaps). |
| `contributes.languageServers[]` | Up to 8 language servers the editor talks to, as data: Ostia starts each one itself and speaks LSP to it. Needs the `language-server` capability; no `main` needed. See [Language servers](#language-servers). |
| `contributes.editorLanguages[]` | Up to 16 languages the editor does not know yet, each with a Monarch grammar as JSON. Data only: no `main` and no capability needed. See [Editor languages](#editor-languages). |
| `contributes.fileKinds[]` | API 5.0, `browse` API 6.4. Up to 16 kinds of file, each matched by file name and given a `view` role that shows the file read-only and/or a `browse` role that lists and opens what is inside it: `{id, displayName, selector: [{filenamePattern}], view?: {entry, priority?}, browse?: {}}`. A view needs no `main` and no capability; a browse needs `main` and the `file-contents` capability. The human approves each claim. See [File kinds](#file-kinds). |
| `contributes.agentSkills[]` | Up to 8 skills that Ostia gives claude and codex in your terminals: `{name, path, files?}`. Needs the `agent-plugin` capability. See [Agent skills and hooks](#agent-skills-and-hooks). |
| `contributes.agentHooks[]` | Up to 16 `{event, command}`: when the agent reaches `event`, Ostia runs your own command `command` with the hook's JSON on stdin. Needs the `agent-plugin` capability and `main`. See [Agent skills and hooks](#agent-skills-and-hooks). |

Icons are a fixed set: `puzzle`, `kanban`, `book-open`, `git-branch`, `globe`, `bell`, `server`,
`terminal`, `circle`, `check`, `alert`, `shield`, `chat`, `plugs`, `magnifying-glass` (API 2.1), `graph`, `toolbox` (API 6.8).

## Translations

Each extension owns its wording in every language. Ostia translates nothing for you and no other
extension can: a language pack (`contributes.languages`) covers Ostia's own interface only.

Write the manifest in English, list the languages you translate into, and ship one catalog per
language:

```json
{ "id": "dev-ports", "name": "Ports", "locales": ["zh-Hant"], "contributes": { … } }
```

```
dev-ports/
  ostia.json
  main.js
  locales/
    en.json         messages only: the English your process shows
    zh-Hant.json    manifest strings and messages in Traditional Chinese
```

```json
{
  "manifest": {
    "name": "連接埠",
    "description": "顯示每個工作區正在監聽的開發伺服器。",
    "commands.open.title": "開啟連接埠",
    "commands.find.argument": "連接埠號碼",
    "panel.title": "連接埠",
    "workspaceChips.ports.title": "監聽中的連接埠",
    "settings.interval.title": "掃描間隔",
    "settings.interval.description": "{product} 在前景時，每次掃描的間隔時間",
    "settings.sort.valueTitles.port": "依連接埠"
  },
  "messages": {
    "found": "找到 {count} 個連接埠"
  }
}
```

A catalog has two sections and nothing else, each a flat object of strings.

### `manifest`: what Ostia shows for you

Keys name a string your manifest declares:

| Key | Translates |
|---|---|
| `name`, `description` | The extension's name and description |
| `commands.<id>.title`, `.category`, `.argument` | A command's palette title, its group and its argument prompt |
| `panel.title` | The panel's toggle and tab title |
| `settingsPage.title` | Your settings page's entry and heading in Settings |
| `paneChips.<id>.title`, `workspaceChips.<id>.title` | A chip's name in tooltips and Settings → Prompt |
| `settings.<key>.title`, `.description`, `.valueTitles.<value>` | A setting's label, help text and enum option labels |
| `secrets.<key>.title`, `.description` | A secret's label and help text |
| `connections.<kind>.title`, `.description`, `connections.<kind>.fields.<key>.title`, `.description`, `connections.<kind>.secrets.<key>.title`, `.description` | A connection kind's, field's and secret's label and help text |

Ostia reads `locales/<tag>.json` for every tag in `locales`, in main, the way it reads your
manifest: a regular file inside the extension (no symlink anywhere on its path), at most 256 KiB.
It keeps a string only when its key is one of the above **for something your manifest declares**
and its value fits the limits of the string it replaces (non-empty, the same maximum length, no
control characters). So a catalog can reword what the manifest says and nothing more: it cannot
add a command, a setting, an option or a title the manifest lacks, and it never carries ids,
`usage`, values, capabilities, markup or code. Anything else in the section is dropped and logged
(`ostia-extension validate` reports it as an error), and the rest of the catalog still applies.

Not translatable: `id`s, `version`, `usage` (it is command syntax, shown to agents), enum `values`,
`contributes.snippets`, and the `label`s of icon themes, keymaps and languages (write a language's label
in that language). Keep `{product}` as it is.

Ostia resolves the strings for the human's language before the interface sees them, string by
string: a key your catalog leaves out shows the manifest's English. Wherever the manifest is shown
(Settings → Extensions and your settings form, the marketplace list, the approval dialog, the
palette, your panel's toggle and tab, chip names) follows, and switches when the human changes the
language or your extension folder changes; nothing restarts. A catalog is read with its manifest,
so the approval dialog and a marketplace listing are translated before the extension is enabled.
Agents always get the manifest's own strings (`ostia ext list`, `ostia docs`).

### `messages`: what your process and panel show

Text you send at runtime (chip text, sidebar items, `ext.confirm` dialogs, notifications, command
results, panel pages) is yours to translate. Ostia passes it through as written and never reads
the `messages` section. The SDK reads it for you:

```ts
import { connect, createTranslator, ok } from '@aurigax-ai/ostia-extension-sdk'

const ext = await connect()
const translate = createTranslator()

await ext.registerCommands({
  find: async (_args, caller) => {
    const t = translate(caller.locale)
    return ok(t('found', { count: 3 }))
  },
})
```

`createTranslator(dir?)` reads the `messages` of every `locales/*.json` once (from
`OSTIA_EXTENSION_DIR`, your extension folder, unless you pass one) and returns a function from a
locale to `t(key, vars?)`. `t` looks the key up in the language's catalog, then in `en`, then
returns the key itself; `{name}` placeholders are filled from `vars`. `locales/en.json` holds your
English messages and needs no entry in `locales` (that list is only for the manifest).

If your strings are typed objects in code instead of JSON, `localized({ en, 'zh-Hant': zhHant },
locale)` picks one by the same rule. In a panel page, `pickLocale(dicts)` and
`panelTranslator(catalogs)` from `…/panel` do the same for the panel's `context.locale`; bundle
the catalogs into the page (`import zhHant from '../locales/zh-Hant.json'`).

### Which language you get

There is one language: the one the human picked in Settings → Language (`locale` in
`settings.json`, a tag such as `en` or `zh-Hant`; `en` when unset). You see it in three places,
always the same value:

- `caller.locale` on every command and panel request, read when the request is made;
- `ext.getLocale()` (`ext.locale`), for text you push without a caller: chips, sidebar items,
  notifications;
- `ext.onLocaleChanged(handler)` (the `locale.changed` event, sent without `ext.subscribe`) when
  the human changes it while you run. Set your chips and sidebar items again in the new language;
  Ostia does not re-ask for them. An open `url` panel is asked for its URL again (`ext.panel`) with
  the new `caller.locale`.

A catalog matches a locale by tag: the exact tag first (case does not matter), then the tag with
trailing subtags dropped (`zh-Hant-TW` → `zh-Hant` → `zh`), then the first catalog you list for
the same language (`zh-TW` → `zh-Hant`). No match means English.

### Translating someone else's extension

You cannot, from outside it. Ostia reads an extension's catalogs only from that extension's own
folder, and a language pack's keys are limited to Ostia's own catalog. That is deliberate: an
extension's name, command titles and setting descriptions are what the human reads before
approving it, so only the author it was approved from may word them. To add a language to an
extension you do not own, send its author the `locales/<tag>.json` file (one file and one entry in
`locales`), or publish your own build of it under a different id.

## Icon themes

`contributes.iconThemes` takes VS Code file icon themes as they ship in a `.vsix`, so a theme
such as Material Icon Theme works without changes:

1. Unzip the `.vsix` (it is a zip) and copy its `extension/` folder to
   `~/.config/ostia/extensions/<name>/`.
2. Add a `ostia.json` next to its `package.json`, pointing at the theme JSON the `package.json`
   lists under `contributes.iconThemes[].path`:

   ```json
   {
     "id": "material-icons",
     "name": "Material Icon Theme",
     "version": "5.0.0",
     "contributes": {
       "iconThemes": [
         { "id": "material-icon-theme", "label": "Material Icon Theme", "path": "dist/material-icons.json" }
       ]
     }
   }
   ```

3. Approve the extension when Ostia asks, then pick the theme in Settings → Files → File icon
   theme or the Files header's view options.

What Ostia reads from the theme JSON: `iconDefinitions` (entries with an `iconPath` to an SVG,
PNG, JPEG, GIF or WebP file), `file`, `folder`, `folderExpanded`, `fileExtensions`, `fileNames`,
`folderNames`, `folderNamesExpanded`, `languageIds`, and the same keys under `light` (used with a
light Ostia theme) and `highContrast`. A file resolves like VS Code: `fileNames`, then
`fileExtensions` from the longest suffix (`d.ts` before `ts`), then `languageIds` (the VS Code
language id of the name), then `file`; an open folder tries `folderNamesExpanded`, `folderNames`,
`folderExpanded`, `folder`. Names match case-insensitively.

Not supported: font icon themes (`fonts`, `fontCharacter` definitions are skipped),
`rootFolder*` keys (Ostia's tree has no root row), and `hidesExplorerArrows`.

Main loads a theme only for an enabled extension and checks it: the theme JSON at most 4 MiB,
each icon at most 512 KiB, all icons at most 48 MiB, every path inside the extension folder
after resolving symlinks, and no symlinked file. Icons reach the renderer as `data:` URLs;
the renderer never gets a path.

## Keymaps

A keymap is a set of shortcuts the human can switch to in one step, the way an editor offers
other editors' keybindings. It is data only: a manifest entry and one JSON file, no process.

```json
{
  "id": "keymap-macos",
  "name": "macOS keymap (cmux)",
  "version": "1.0.0",
  "api": "7.0",
  "contributes": {
    "keymaps": [
      { "id": "cmux", "label": "macOS (cmux)", "path": "assets/cmux.json", "platform": "darwin" }
    ]
  }
}
```

The file maps command ids to a chord, a list of chords that all run the command (menus and
hints show the first one that works everywhere), or `null` to unbind a command:

```json
{
  "bindings": {
    "pane.splitRight": "terminal:Cmd+D",
    "pane.splitDown": "terminal:Cmd+Shift+D",
    "tab.next": ["Ctrl+Tab", "Shift+Cmd+]"],
    "dashboard.toggle": "Cmd+Alt+D",
    "view.toggleRail": null
  }
}
```

A list replaces all of the command's default chords. A chord in a list that the computer can't
use is skipped and reported; the rest of the list still applies.

Chords are written as in the `keybindings` setting: modifiers `Ctrl`, `Shift`, `Alt` (`Option`),
`Cmd` (`Meta`, `Super`) and `Mod` (Cmd on macOS, Ctrl elsewhere), then one key (`A`–`Z`, `0`–`9`,
`F1`–`F24`, punctuation, `Up`, `Down`, `Left`, `Right`, `Enter`, `Space`, `Backspace`, `Delete`,
`Home`, `End`, `PageUp`, `PageDown`, `Insert`); `workspace.goto` takes the range `1-9` and no
other command does. A command id is any palette command, including another extension's
(`<extId>.<command>`). Commands the file does not name keep their default.

A chord written with the `terminal:` prefix (`"terminal:Cmd+D"`) runs the command only while a
terminal has the focus. Everywhere else the key keeps its other use: the editor, the browser
and the other panels never see it as this command, and a chord bound without the prefix to
another command still runs there. Ostia's own defaults use this for ⌘K, which clears the
terminal in a terminal and opens the palette everywhere else.

Nothing changes until the human picks the keymap in Settings → Keyboard → Keymap; the choice is
the `keymap` setting, `"<extension id>/<keymap id>"` (`"keymap-macos/cmux"`), and `null`, the
default, means Ostia's own shortcuts. Shortcuts resolve in three layers, and every place that
shows or matches a shortcut (the Keyboard table, the palette and other shortcut hints, conflict warnings) sees the
same result:

1. Ostia's defaults;
2. the chosen keymap's `bindings`, which replace or unbind defaults;
3. the human's `keybindings`, which win over both. "Reset" on a row in Settings → Keyboard
   removes the human's own chord, so the row goes back to the keymap's chord, or the default
   when the keymap does not name the command.

Main reads the file only for an enabled extension and only on the platform it is offered on
(no symlinks, inside the extension, at most 64 KiB) and checks every entry for the computer it
runs on. An entry Ostia cannot use (not a chord, a chord the shell needs such as plain
`Ctrl+letter`, `Escape`, `Tab` or a key without Ctrl or Cmd, `1-9` on a command other than
`workspace.goto`) is skipped, logged as `[keymap <ref>] skipped entries: …`, and listed in a
warning under the picker; the rest of the keymap still applies. A file that cannot be read or
has no `bindings` object leaves the default shortcuts in place and says so under the picker. A
`keymap` setting that no enabled extension offers on this computer (the extension is disabled
or removed, or the keymap is for another platform, as when settings sync from a Mac to Linux)
counts as `null` and is kept, so the keymap comes back with its extension.

## Language servers

An extension gives the editor a language server by describing it in `contributes.languageServers`.
It is data, not code: Ostia spawns the process, speaks LSP to it over stdio, and wires its answers
into the editor. Providers are registered from what the server reports in `initialize`, with its
trigger characters, and from what it registers later with `client/registerCapability` (removed
again on `client/unregisterCapability`); a registration's `documentSelector` is honoured by
language id, scheme and glob. Your extension never owns the process and needs no `main`.

What the editor uses when the server offers it: diagnostics (pushed, and pulled with
`textDocument/diagnostic`: on open, after an edit and on `workspace/diagnostic/refresh`, with the
previous result id; a diagnostic that arrives both ways is shown once), completion (text edits,
extra edits such as auto-imports, snippets, resolve), hover, go to definition, references, rename
with prepare, signature help, document symbols (the outline), document highlights, document and
range formatting (also format on save), code actions (edits and commands, `workspace/applyEdit`),
semantic tokens (full document), inlay hints, folding ranges (whole lines), code lens (with
resolve and `workspace/codeLens/refresh`) and workspace symbols (the palette's `%` prefix, or
Go to Symbol in Workspace, asks the servers of files open in the active workspace). A code lens
is clickable only when its command is one the server lists in `executeCommandProvider.commands`
(or registered for `workspace/executeCommand`); it then runs through `workspace/executeCommand`.
Any other lens, such as one naming an editor command, is shown as text.

A server that registers `workspace/didChangeWatchedFiles` is told about files created, changed
and deleted under its root folder that match its globs (plain or relative patterns, with
`kind`). A watcher based outside the root is ignored, nothing outside the root is ever reported,
and `.git`, `.hg`, `.svn` and `node_modules` folders and linked folders are not watched; at most
2000 folders are watched per root.

Text is synced incrementally when the server
asks for it, and `didSave` is sent when it asked for saves. A workspace edit changes open
documents through the editor (undoable) and closed files on disk, and only inside the server's
root folder: an edit that touches a file outside it, a URI that is not `file:`, or one that
creates, renames or deletes files is refused as a whole. In a sandboxed workspace the root must
also be inside the workspace folder, otherwise the server cannot edit at all. Not wired yet:
type and call hierarchy, workspace-wide diagnostics, semantic token ranges and deltas, and dynamic
registration of text synchronization.

```json
{
  "id": "lsp-pyright",
  "name": "Python (Pyright)",
  "version": "1.0.0",
  "api": "7.0",
  "category": "languages",
  "capabilities": ["language-server"],
  "contributes": {
    "settings": {
      "typeCheckingMode": { "type": "enum", "values": ["off", "basic", "standard", "strict"],
        "default": "standard", "description": "How strictly Pyright checks types" }
    },
    "languageServers": [
      {
        "id": "pyright",
        "name": "Pyright",
        "languages": ["python"],
        "documentLanguageIds": { ".pyi": "python" },
        "run": { "node": "server/langserver.index.js", "args": ["--stdio"] },
        "rootMarkers": ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"],
        "initializationOptions": {},
        "settings": { "python": { "analysis": { "typeCheckingMode": "standard" } } },
        "settingPaths": { "typeCheckingMode": "python.analysis.typeCheckingMode" }
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and dashes, unique in the extension. The server's key is `<extension id>/<id>`. |
| `name` | 1–200 characters, shown on the extension’s row in Settings › Extensions and the approval dialog. |
| `languages` | 1–16 editor (Monaco) language ids, `[a-z][a-z0-9+#-]*`: the files this server is started for. |
| `documentLanguageIds` | Optional. Maps an editor language id, or a file suffix starting with `.`, to the LSP `languageId` sent in `didOpen` (`"shell": "shellscript"`, `".tsx": "typescriptreact"`). The longest matching suffix wins, then the editor language id; without an entry the editor language id is sent. |
| `run` | Exactly one of four forms, each with optional `args`: `node`, `program`, `download` or `goInstall`. See [How the server's program gets there](#how-the-servers-program-gets-there). Nothing else is allowed in `run`. |
| `run.args` | At most 32 strings of at most 200 characters. `{extensionDir}` and `{root}` are replaced, per argument. There is no shell: an argument is never split or expanded. |
| `rootMarkers` | At most 16 file names. The server's root is the nearest folder, from the file upward, that holds one, never above the workspace folder. Without markers, or when none is found, the root is the workspace folder. |
| `initializationOptions`, `settings` | JSON objects of at most 16 KiB each. String values get the same two replacements. `initializationOptions` goes into `initialize`; `settings` answers the server's `workspace/configuration` requests by section and, when it is not empty, is sent once as `workspace/didChangeConfiguration` right after `initialized`. |
| `settingPaths` | Maps one of your own `contributes.settings` keys to a dotted path in `settings`. Ostia lays the human's value over `settings` before answering, and sends `workspace/didChangeConfiguration` when it changes. |

The human can give any server their own program on the extension’s row in Settings › Extensions: an absolute path to an
executable file, with extra arguments. It then runs instead of every `run` form (the program on
`PATH`, the copy Ostia keeps, or the bundled script), with your `run.args` first and theirs after.
An extension cannot set or read this choice.

### How the server's program gets there

A server reaches the human's machine in one of four ways. Pick the one that fits the server; you
cannot mix them in one `run`.

| `run` form | Use it for | What happens |
|---|---|---|
| `{ "node": "server/cli.mjs" }` | A server written in JavaScript | Its files ship inside your extension folder, so installing the extension is the download. Ostia runs the `.js`, `.mjs` or `.cjs` file with its own Electron as Node (`ELECTRON_RUN_AS_NODE=1`); no system Node is needed. The path must be a regular file inside the extension, checked again after symlinks are resolved. |
| `{ "download": { … } }` | A native server with release binaries | Ostia uses the program on the human's `PATH` when there is one. Otherwise it downloads the pinned asset for the platform, checks its SHA-256, unpacks it into its own data folder and runs that copy. |
| `{ "goInstall": { … } }` | A Go server without release binaries | Ostia uses the binary on `PATH` when there is one. Otherwise it runs `go install <module>@<version>` with `GOBIN` in its own data folder. Needs Go on `PATH`. |
| `{ "program": "name", "package": "name" }` | A server Ostia cannot fetch | Looked up on `PATH` only. While it is missing the server is off and the extension’s row in Settings › Extensions offers to install `package` (default: the program name) through the System extension, which shows the human the exact command first. |

The `download` form:

```json
"run": {
  "download": {
    "program": "rust-analyzer",
    "version": "2026-09-28",
    "assets": {
      "linux-x64": {
        "url": "https://github.com/rust-lang/rust-analyzer/releases/download/2026-09-28/rust-analyzer-x86_64-unknown-linux-gnu.gz",
        "sha256": "23f711d86b5f826e22886f01d7355dc01e0f4c1357dafa29710a95b903b48c85",
        "archive": "gz",
        "executable": "rust-analyzer"
      }
    }
  },
  "args": []
}
```

- `program` is the name looked up on `PATH` first. The human's own binary always wins.
- `version` is the pinned version, 1–64 characters of `[A-Za-z0-9._+-]`. `latest` is refused.
- `assets` has one entry per platform you support: `linux-x64`, `linux-arm64`, `darwin-x64`,
  `darwin-arm64`, `win32-x64`, `win32-arm64`. On a platform without an entry the server is
  `PATH`-only, like the `program` form.
- `url` must be `https` on `github.com`, `objects.githubusercontent.com` or
  `release-assets.githubusercontent.com`, with no credentials and no port. Redirects are followed
  only to those hosts.
- `sha256` is required: 64 lowercase hex characters of the file at `url`. Compute it from the file
  you downloaded yourself (`sha256sum <file>`); Ostia refuses the download when it differs.
- `archive` is `plain` (the file is the program), `gz` (one gzipped program), `tar.gz` or `zip`.
- `executable` is the program's path inside the unpacked archive (`clangd_23.1.0/bin/clangd`), or
  the file name to give a `plain` or `gz` download. No `..`, no leading `/`.

The `goInstall` form:

```json
"run": {
  "goInstall": { "module": "golang.org/x/tools/gopls", "version": "v0.23.0", "binary": "gopls" },
  "args": []
}
```

- `module` is a Go module path: lowercase host and path segments, nothing that could be a flag.
- `version` is `vX.Y.Z` exactly. `latest`, branches and pre-releases are refused.
- `binary` is the program name `go install` produces, also the name looked up on `PATH` first.
- Ostia runs exactly `go install <module>@<version>` and nothing else: no other subcommand, no
  extra arguments from the manifest, never through a shell.

What Ostia guarantees for `download` and `goInstall`:

- **Only after approval, only on demand.** Nothing is fetched for an extension that is merely
  listed, disabled or waiting for approval, and nothing at app start. The fetch happens when a
  file of one of the server's languages opens, or when the human presses the fetch button in
  its row in Settings › Extensions. The approval dialog states what will be downloaded, or the exact
  `go install` command, before the human approves.
- **`PATH` first.** A program the human installed themselves is never replaced or shadowed.
- **Checked before it can run.** A download is limited to 256 MiB, hashed while it is written, and
  thrown away when the SHA-256 differs. Only then is it unpacked: at most 1 GiB and 20,000 files,
  no entry outside the folder, no symlinks, hard links or special files. Nothing from the archive
  is executed while installing, and nothing goes through a shell or a package manager.
- **In Ostia's own folder.** The copy lives in `language-servers/<extension id>/<server id>/<version>/`
  under Ostia's data folder (mode 0700), never in the workspace. An older version is removed when a
  new one is in place, and everything of an extension is removed when it is uninstalled. The human
  can remove a copy on the extension’s row in Settings › Extensions; Ostia then does not fetch it again until asked.
- **Little is sent.** The request carries a `User-Agent` with the product name and version and
  nothing else: no cookies, no token.
- **`go install` runs with a scrubbed environment**: no `OSTIA_*` or `OSTIA_*` variable, `GOFLAGS` cleared, a
  time limit, and its output only in the server's in-memory log.

How Ostia runs a server:

- **Start.** A server starts when a file of one of its languages opens in the editor, once per
  server, root folder and window. cwd is the root.
- **Environment.** The process gets Ostia's environment without any `OSTIA_*` or `OSTIA_*` variable: no socket,
  no token. A language server cannot call Ostia.
- **Sandboxed workspaces.** In a sandboxed workspace the server runs inside that workspace's
  sandbox, or not at all. Your extension's folder and the folder of the copy Ostia fetched are
  readable there (read-only, and only that server's version folder). A program from the human's
  `PATH` that lives under the home folder (for example `~/.cargo/bin`) is not readable until the
  human adds a read path, and Settings says so. The fetch itself runs on the host: it is Ostia's
  action after the human's approval, not something the sandboxed workspace does.
- **Stop.** With no document open for a minute Ostia sends `shutdown` and `exit`. A crash restarts
  it with a growing delay, at most five times; after that it is shown as crashed until the human
  presses Restart.
- **The human's controls.** The extension’s row in Settings › Extensions lists every server with its status (including
  `Downloading… 40%` and a failed fetch with its reason and Retry), where its program comes from
  (`PATH` or Ostia's copy and its version), an on/off switch, Restart, a way to remove Ostia's copy,
  and a log (start, exit, restarts, fetches, the server's stderr; kept in memory only). There is
  no socket method or CLI verb for any of it.
- **The editor's own features step aside.** Monaco has built-in features for JSON, CSS, SCSS,
  LESS and HTML. While an enabled server that can run claims one of those languages, Ostia turns
  the built-in ones off for it (the tokenizer stays), and turns them back on when the server is
  switched off, uninstalled or has crashed for good. `settings.json` is the exception: it always
  keeps Ostia's own schema checks and is never sent to a server. Ostia ships no language features
  for any other language: TypeScript, JavaScript, Python and the rest are only highlighted until
  an extension provides a server.
- **No folder trust prompt.** Ostia has no per-folder trust setting. A server runs project code
  (build scripts, plugins) with the human's rights once its extension is approved and a matching
  file opens; a sandboxed workspace is the way to confine it.

### Editor languages

A language server is started for an editor language id. The editor knows the common ones
(`typescript`, `python`, `rust`, `go`, `yaml`, `shell`, `markdown`, …); for a language it does
not know, declare it in `contributes.editorLanguages` and name its id in your server's
`languages`:

```json
"editorLanguages": [
  {
    "id": "gleam",
    "name": "Gleam",
    "extensions": [".gleam"],
    "filenames": ["gleam.toml"],
    "configuration": {
      "lineComment": "//",
      "blockComment": ["/*", "*/"],
      "brackets": [["{", "}"], ["[", "]"], ["(", ")"]],
      "autoClosingPairs": [["{", "}"], ["\"", "\""]]
    },
    "grammar": "gleam.monarch.json"
  }
]
```

| Field | Meaning |
|---|---|
| `id` | `[a-z][a-z0-9+#-]*`, at most 40 characters. An id the editor already has is refused: a contribution adds a language, it never replaces one. |
| `name` | 1–80 characters, shown as the language's name. |
| `extensions`, `filenames` | Up to 16 each; at least one in total. An extension starts with a dot (`.gleam`, `.test.gleam`; the longest match wins), a file name is matched whole (`Justfile`). A file the editor already has a language for keeps it. |
| `configuration` | Optional: `lineComment`, `blockComment` (a pair), `brackets` and `autoClosingPairs` (up to 16 pairs each). Every string is 1–10 characters. |
| `grammar` | A `.json` file inside the extension holding a [Monarch](https://microsoft.github.io/monaco-editor/monarch.html) grammar with every regular expression written as a string. |

Main reads the grammar only while the extension is enabled and checks it: no symlink, inside the
extension folder after symlinks are resolved, at most 256 KiB, at most 200 states of 500 rules,
every rule starts with a regular expression of at most 2000 characters that compiles
(`@name` references are allowed), and prototype keys are dropped. A grammar is data: it cannot
hold functions. TextMate grammars are not supported. A slow regular expression still runs on the
editor's thread, so keep rules simple.

### Being suggested

Nothing extra is needed to be offered to the right people. When someone opens a file and no
enabled server claims its language, Ostia looks through the marketplaces they have added (the
copies already on disk; it never fetches for this) for an extension whose
`contributes.languageServers` covers that language, and shows one quiet line above the editor:
"<your extension> adds language features for .x files." with **Install** and **No**. Install
copies the extension from the marketplace, exactly like the button in Settings → Extensions;
your extension then waits for approval like any other. No is remembered per extension.

Ostia also carries a small compiled table (`src/shared/extensions/extensionSuggestions.ts`) of the language
extensions it publishes itself and the file names and suffixes each is suggested for, so the
offer works before the official marketplace has been downloaded; Install then downloads it
first. An id in that table is only ever taken from the official marketplace, whatever another
marketplace lists under the same id.

## Agent skills and hooks

Ostia starts `claude` and `codex` in a zsh or bash pane with its own session plugin: the `ostia`
skill plus hooks for the pane's attention state and resume token. An extension can add to it:
skills (instructions the agent reads when a task matches) and hooks (your commands, run when the
agent reaches an event). Ostia adds **only what your manifest declares**. It never looks for a
`skills/` folder, a `SKILL.md`, a `hooks.json` or a `.claude-plugin` folder on its own: a skill
folder or file your manifest doesn't name is not copied, and an extension without
`agentSkills`/`agentHooks` adds nothing.

```json
{
  "id": "review-kit",
  "api": "7.0",
  "capabilities": ["agent-plugin"],
  "main": "main.js",
  "contributes": {
    "commands": [
      { "id": "on-hook", "title": "Review kit: agent hook", "palette": false, "stdin": true }
    ],
    "agentSkills": [{ "name": "review", "path": "skills/review", "files": ["checklist.md"] }],
    "agentHooks": [
      { "event": "SessionStart", "command": "on-hook" },
      { "event": "PostToolUse", "command": "on-hook" }
    ]
  }
}
```

Both need the `agent-plugin` capability, which the human approves like any other. The approval
dialog and your row in Settings → Extensions list every skill and hook you add, and say that a
hook sees what the agent reports (your prompt, the tools it runs).

### Skills

| Field | Meaning |
|---|---|
| `name` | Lowercase letters, digits and dashes, unique in the extension. The agent sees the skill as `<extension id>-<name>` (`review-kit-review`). |
| `path` | A folder inside the extension that holds `SKILL.md`. |
| `files` | Optional. Up to 16 more files in that same folder (`.md` or `.txt`, no subfolders) that the skill refers to. Only these and `SKILL.md` are copied. |

`SKILL.md` starts with frontmatter whose `name` is the skill's `name` from the manifest and whose
`description` (one line, at most 1024 characters) says when to use the skill:

```markdown
---
name: review
description: Reviews a change in this repository against checklist.md. Use when asked to review a diff, a branch or a pull request here.
---
```

The frontmatter is read by a small line parser, not a YAML library: only `key: value` lines at
column 0, with a plain one-line value optionally in one pair of matching quotes (no escapes), and
exactly one `name` and one `description`. Block scalars (`>`, `|`), indented or nested lines, flow
collections, anchors, aliases, tags, quoted keys, a space before the colon, duplicate keys,
comments (`#`) and a second frontmatter block are refused, and `ostia-extension validate` reports
the line.

The frontmatter carries only `name` and `description`. Any other key is refused, because Claude Code
honours keys such as `allowed-tools`, `model`, `hooks`, `context` and `shell` that pre-approve tools,
switch the model or run commands, and the approval dialog never shows them. For the same reason a
`SKILL.md` that holds Claude Code's shell injection, `` !`command` `` or a ` ```! ` block (also with
a lookalike `!` or backtick), is refused. Control characters and line separators inside the
frontmatter are refused too. The same rule refuses a command built from the skill's arguments (`` !$ARGUMENTS ``, a fence line
that starts with `$`). A refused skill is not written for the agent. The marketplace lists its
extension under "not compatible" with the reason, and the extension's row in Settings → Extensions
and its approval dialog show it (`ExtensionInfo.agentSkillProblems`, API 6.9).

Ostia writes the copy's `name` as `<extension id>-<name>`, so two extensions' skills never
collide and none can take the name of Ostia's own `ostia` skill.

Main reads the files only while the extension is enabled and its `agent-plugin` capability is
approved, and checks each one: a regular file inside the extension folder with no symlink
anywhere on its path, plain UTF-8 text, at most 256 KiB, at most 1 MiB for the whole skill. A
skill that fails is left out and logged, and `ostia-extension validate` reports it. Claude gets
the files as a skill of Ostia's plugin; Codex has no way to add a skill folder, so its session
context lists each skill's description and the path of its `SKILL.md` for it to read.

### Writing an agent skill

Ostia's own skills follow Anthropic's skill authoring best practices, and a guard test holds the
skills in this repository to these rules:

- `name`: lowercase letters, digits and hyphens, at most 64 characters, without `anthropic` or
  `claude`.
- `description`: third person, at most 1024 characters: what the skill does, then a
  `Use when …` sentence naming the tasks and words that should bring it up.
- Teach command usage only: what each command does, its inputs, output, exit codes, refusals and
  the capability it asks for, with concrete examples. Limits the product enforces are facts of
  the command. No workflow policy, etiquette, layout defaults, naming schemes or advice about
  other tools.
- `SKILL.md` stays under 500 lines. Move a long section that only some tasks need into a file
  listed in `files`, link it from `SKILL.md`, and link nothing further from it; a file over 100
  lines starts with a `## Contents` list.
- One term per thing (pane, split tab, workspace), nothing time-sensitive, forward slashes in
  paths, and only `ostia <noun> <verb>` forms that `ostia <noun> --help` lists.

### Hooks

`event` is one of:

| Event | claude | codex | Your text reaches the agent |
|---|---|---|---|
| `SessionStart` | yes | yes | yes, as added context |
| `UserPromptSubmit` | yes | yes | yes, as added context |
| `PreToolUse` | yes | yes | no |
| `PostToolUse` | yes | yes | no |
| `Stop` | yes | yes | no |
| `SessionEnd` | yes | yes | no |
| `Notification` | yes | no (Codex has no such event) | no |

`command` is one of your own `contributes.commands` ids. It must have `stdin: true`, no
`capabilities` and no `interactive`. You never write a shell command: Ostia generates the hook,
which runs `ostia agent-hook <your id> <command> <agent> <event>` and so reaches you as an
ordinary `ext.command` call from that pane, with your approved capabilities and nothing more:

- `args.argv` is `[agent, event]` (`["claude", "SessionStart"]`), `args.stdin` the agent's hook
  JSON (at most 1 MiB; larger input skips the call). `caller` is the pane the agent runs in,
  with `sandboxed: true` in a sandboxed workspace.
- For `SessionStart` and `UserPromptSubmit`, the `text` of your result (at most 10,000
  characters) is added to the agent's context. Ostia wraps it in the agent's own
  `additionalContext` output, so text that looks like a hook decision is still only context.
- For every other event your result is not passed on: a hook observes, it can never allow,
  deny or block a tool call, a prompt or the end of a turn.
- The hook waits for your reply up to the usual 30 s, so the agent waits too. Answer quickly.
- An agent in the pane can also run your command directly (`ostia <id> on-hook`), like any
  command; treat the input as data, not as proof that the agent sent it.
- A pane that ran one of your hook commands is one you may show with `ext.focusPane` (API 3.1).
- What the input holds is the agent's business and differs by agent and version. Checked with
  Claude Code 2.1 and Codex 0.157: `UserPromptSubmit` has `prompt`; `PreToolUse` has `tool_name`
  and `tool_input`; `Stop` has `last_assistant_message`, the agent's closing message for the
  turn; all have `session_id`, `cwd` and `transcript_path`. Read a field only when it is there.
- When Ostia isn't reachable (it quit, or a sandboxed workspace has Unix sockets off) the hook
  does nothing and the agent goes on.

Codex runs a hook only if it trusts it. Ostia passes each of your hooks with the hash Codex itself
computes for it, like its own hooks, and never `--dangerously-bypass-hook-trust`.

### When the agent gets them

Ostia rebuilds the plugin whenever an extension is approved, enabled, disabled, updated or
removed, in a new folder, so nothing in use changes underneath. Panes opened after that get the
new set the next time they start `claude` or `codex`. A shell that was already open keeps the
set it started with until you open a new pane, and a running agent keeps what it started with
until it restarts. The `ostia manager` agent never gets extension skills or hooks: it holds almost
every capability, so Ostia keeps its context to what the human picked for it.

## Approval and capabilities

- The first launch of a user extension shows a dialog listing its `capabilities` and, for each
  language server, the command it runs, for which files, and what Ostia would fetch for it (the
  download's program, version and host, or the exact `go install` command), and every agent
  skill and hook it adds. Approve and it runs with exactly those; "Keep disabled" records the
  decision. Built-ins skip the dialog.
- If a new version asks for more, it runs with the previously approved subset until the user
  reviews it in Settings.
- Only the human approves. There is no socket method or CLI verb for it, and agents can't grant
  themselves anything.
- Your process runs as the user, like any program. Capabilities limit what you can do **through
  Ostia** (events, notifications, other panes); they are not an OS sandbox.

## Talking to Ostia

Your process gets:

| Env | Value |
|---|---|
| `OSTIA_SOCKET` | Control socket path |
| `OSTIA_TOKEN` | This run's token (a new one on every start) |
| `OSTIA_EXTENSION_ID` | Your `id` |
| `OSTIA_EXTENSION_DIR` | Your directory |
| `OSTIA_EXTENSION_DATA` | A folder for your own state (`<userData>/extension-data/<id>`); create it when you first write. It isn't synced. |

Connect to the unix socket and speak JSON-RPC 2.0 with LSP-style framing
(`Content-Length: N\r\n\r\n<json>`); `vscode-jsonrpc` does this for Node. Then:

1. `hello {token}`.
2. `ext.registerCommands {commands}` — always, even with `[]`; it is also your "ready" signal.
   Pass the ids of manifest commands you handle. You may also pass full objects
   (`{id, title, …}`) for extra commands that exist only while you run.
3. Whatever else you need.

### Methods you call

| Method | Params | Notes |
|---|---|---|
| `ext.registerCommands` | `{commands: (string \| CommandContribution)[]}` | Returns `{ok, commands}`. |
| `ext.subscribe` | `{events: string[]}` | `pane.created`, `pane.closed`, `command.started`, `command.finished`, `cwd.changed`, `focus.changed`, (API 4.1) `pane.attention` and (API 4.2) `workspace.closed` and (API 4.9) `pane.lifecycle` need `read-board`; `notification` needs `notify`; (API 4.9) `bus.message` needs `read-bus`, a capability no extension holds by default and the human grants (never the manager's). |
| `ext.setSidebarItem` | `{key?, workspaceId?, text, icon?, badge?, tone?, kind?, url?}` | `badge` (1-6 letters or digits, e.g. `SSH`) shows as a small outlined label before `text`, to say what kind of thing the item is; anything else is ignored. With `workspaceId` it shows on that workspace's row, without it in the sidebar footer. `tone`: `neutral`, `brand`, `ok`, `warn`, `error`. `kind` places a row item: `location` (where the workspace is, like a branch) shares the line with the folder; `live` (the default; what is running, like ports or counts) goes on the line below, where items that don't fit fold into a `+N` popover. The footer ignores `kind`. Empty `text` removes the item. 80 chars, 32 items. With an http(s) `url` the item is a link: clicking it switches to that workspace and opens the URL in its browser pane. |
| `ext.startWithWindow` | `{on}` | `on: true` makes Ostia start you with the window from the next launch on, until you call it with `false`; for an extension that has work to pick up after a restart (Graphs while a run is unfinished). Kept by Ostia on this computer, never synced. A non-boolean `on` is `invalid-params`. |
| `ext.wireRuntime` | `{}` | The graphs built-in only (`graphs-only` otherwise). Ostia writes its own token file for the Wire Graph Runtime (`@aurigax-ai/wire`), starts the runtime bundled with the app when none answers on its socket, and answers `{ok: true, socket, token, started, mode, version}` for the extension to connect with. A runtime of another contract is never stopped or replaced: the answer is `{ok: false, error: 'other-contract', contract, version}`. |
| `ext.notify` | `{title, body?, openPanel?}` | Needs `notify`. Goes into the notification center and the desktop. With `openPanel: true` (and a panel in your manifest) clicking it shows your panel instead of jumping to a pane; with `openPanel: "/path"` it shows the panel at that path (or navigates your shown panel there), from the desktop notice and from the notification center alike. |
| `ext.openPanel` | `{workspaceId?, path?}` | Shows your panel in the window's right side panel for that workspace, else the active one, without taking the keyboard. A panel that is already shown is not reloaded; with `path` it navigates there. See [Panels](#panels) for what `path` means. |
| `ext.setPanelToolbar` | `{workspaceId, tab?, back?, badges?, disabled?, hidden?}` | API 7.0. Sets what your panel's toolbar row shows for that workspace; see [Panel toolbar](#panel-toolbar). `{ok: true}`, or `invalid-params` for an id your manifest does not declare, or `not-contributed` without a panel. `setPanelToolbar(state)` in the panel page reaches it through the panel server. |
| `ext.setPaneChip` | `{paneId, id, text, tooltip?, tone?, icon?, items?, command?, url?}` | Shows `text` (40 chars) as chip `id` (from your `contributes.paneChips`) on that pane's header; setting it again replaces the value. `paneId` is an external pane id (`caller.paneId`, `pane.list`, events). `tone`: as for sidebar items. `command`: one of your own palette commands; clicking the chip focuses the pane and runs it, so `caller.paneId` is that pane. `url` (http/https, instead of `command`): clicking the chip opens it in the browser pane of that pane's workspace. `icon` (one of the sidebar item icon names, e.g. `plugs`): the chip shows as that icon with `text` as a small badge, which keeps the header narrow (a count reads best); with `items` it shows a dot instead of the badge, since the list itself gives the count. `items` (instead of `command` or `url`; 1-20 `{text, detail?, url?}`, text and detail 80 chars each, url http/https): clicking the chip lists them in a popover, `detail` in muted text after `text`; an item with a url opens in the browser pane on click and can be copied. A bad `icon`, `items` or `url` is refused with `invalid-params`. Empty `text` clears it. Chips vanish when the pane closes or your process stops; set them again after a restart. |
| `ext.clearPaneChip` | `{paneId, id}` | Removes that chip. |
| `ext.setWorkspaceChip` | `{workspaceId, id, text, tooltip?, tone?, icon?, items?, command?, url?}` | Shows chip `id` (from your `contributes.workspaceChips`) in the top bar while that workspace is the active one. `workspaceId` comes from `workspace.list` or events; one that isn't open is refused with `unknown-workspace`. The value is checked exactly like `ext.setPaneChip`'s; `command` runs your palette command for the workspace's active pane, and `url` opens in that workspace's browser pane. Only the window that holds the workspace receives it. Chips vanish when the workspace closes or your process stops. |
| `ext.clearWorkspaceChip` | `{workspaceId, id}` | Removes that chip. |
| `ext.getSettings` | — | `{ok, values}`: every key of your `contributes.settings`, with the human's value when it is valid, else the default. You also get `settings.changed` (below) whenever the values change. |
| `ext.setSetting` | `{key, value}` | Changes one of **your own** settings, for a control in your panel that mirrors it (a sort order or a layout toggle). Validated against your manifest exactly like Settings → Extensions (`unknown-setting`, `invalid-value`); `null` resets the key. Ostia saves it in `settings.json`, shows it in Settings, and sends you `settings.changed`. Returns `{ok, values}`. You can't touch another extension's settings or any core setting. |
| `ext.openDiff` | `{title, original, modified, language?, path?, workspaceId?}` | Opens a read-only diff pane (Monaco's diff editor, side-by-side with an inline toggle) in that workspace, else the active one. Reuses the workspace's diff pane if it has one. Each side is capped at 5 MiB; `path` must be absolute and enables "Open in External Editor" at the cursor; `language` is a Monaco id, otherwise inferred from `path`. The content lives only in memory: a restored workspace drops diff panes. |
| `ext.openFile` | `{workspaceId, path, line?, column?}` | Opens a file in that workspace's editor, at `line` and `column` (1-based) when given, the way `ostia <file>:<line>` does for the human. `path` must be absolute and name a regular file Ostia's file views may already read (inside the home folder, or a file the human opened before); this never grants access to anything else. Returns `{ok}`, or `unknown-workspace`, `outside-roots`, `not-a-file`. Use it for a result the human picked, such as a search hit in your panel. |
| `workspace.list` | — | Needs `read-board`. `[{workspaceId, name, kind, workDir, state, activePaneId?}]`. |
| `pane.list` | — | Needs `read-board`. `[{paneId, workspaceId, kind, title, cwd?, filePath?, running, blockCount, lastExitCode?, pid?, agent?, agentSessionId?, agentState?, agentMessage?, hibernated?}]`; `cwd` is the live shell cwd for terminals; `filePath` is the absolute path a file view (`kind: 'editor'`) shows, so a palette command can act on the file in the caller's pane; `paneId` stays the same when Ostia restarts and restores the pane; a pane opened later gets a new one. For a terminal pane: `agent` is the agent running in it (`claude`, `codex`, or `other` for an agent Ostia cannot name), absent when none runs; `agentSessionId` is the last session id the agent reported (kept after it exits, so the session can be resumed); `agentState` is `working`, `waiting` (needs the human, e.g. a permission prompt), `done` or `error`, with `agentMessage` saying what it waits for; `hibernated` (API 3.3) is `true` while the pane is hibernated. `pid` is the shell process of a terminal whose pty is running (absent for other kinds and for a hibernated pane). Its descendants are what the pane runs. They inherit Ostia's own open descriptors, so ignore sockets your parent process (Ostia) also holds. |
| `ext.locale` | — | `{ok, locale}`: the human's language (`ext.getLocale()` in the SDK). See "Translations". |
| `ext.confirm` | `{title, message, detail?, confirmLabel?, cancelLabel?}` | Asks the human in a native dialog that names your extension; Cancel is the default. Returns `{ok, confirmed}`. Use it before anything that changes the user's files or data. It waits for the human: mark a command that calls it `interactive` so its caller waits too. If the human answers after the timeout anyway, finish the work they chose. |
| `ext.getSecret` | `{key}` | `{ok, value}`: the value the human stored for one of your `contributes.secrets` keys, or `null`. Keep it in memory; don't log it. |
| `ext.connections` | — | API 4.1. `{ok, connections: [{name, kind}]}`: the connections the human made for you, of kinds your manifest still declares. `connections()` in the SDK. |
| `ext.connection` | `{name}` | API 4.1. `{ok, connection: {name, kind, fields, secrets} \| null}`: one of your connections with its field values and its secrets in plain text, for the call you are about to make; `null` for a name you don't have. Keep the secrets in memory for that call; don't log or store them. `connection(name)` in the SDK. `ext.getSecret` never returns a connection's secret. |
| `ext.setAssistStatus` | `{status: {<point>: {ready, label?, tools?}}, features?, setup?, lastError?, label?, models?, providers?, kinds?}` | Needs `assist`. Which of your assist points are usable right now. Only `ready` points are offered to the human. `features` lists the switches Ostia shows in its Assistant menu and in Settings → Assistant: `[{id, setting, ready}]` with `id` one of `chat`, `typos`, `promptReview`, `commandSuggest`, `terminalCompletions`, `editorCompletions`, `explainError` and `setting` one of your own boolean settings (Ostia reads on/off from it and flips it when the human does). `setup` names what is missing (`no-provider`, `no-endpoint`, `no-key`, `no-model`, `unreachable`, or `null`), `lastError` the last provider error (240 chars). `models: true` says you answer `ext.assistModels`. **One model:** leave `providers` out; you are then a single choice in the model lists, named by `label` (80 chars, `model-runtime · gemma`), and `tools` on the `chat` status says how you handle chat tools (see [Chat tools](#chat-tools)). **Several models:** send `providers: [{id, kind, name, setup, lastError?, lifecycle, models: [{id, tools?}]}]` (16 providers, 64 models each; ids match `[a-z0-9][a-z0-9-]{0,31}`). Every model of a provider whose `setup` is `null` becomes a choice the human can pick for chat, for the fast features, or per chat; `tools` is then per model. `kinds: [{id, title, baseUrl, key: 'required' \| 'optional'}]` are the provider kinds the human may add for you in Settings → Assistant (see [Providers and models](#providers-and-models)). Call it at start and whenever your configuration or health changes. |
| `ext.shortcuts` | `{ids: string[]}` | `{ok, shortcuts: {<command id>: label \| null}}`: the human's effective key for Ostia palette commands (`assist.chat`, `assist.compose`, `palette.toggle`, …), so a panel can show the real shortcut. |
| `ext.openAssistUi` | `{ui, workspaceId?}` | Opens Ostia's own UI for an assist point you contribute: `chat` (the chat pane), `ask` (the palette's Ask) or `compose` (the composer on the active terminal). It opens the UI only; nothing is sent until the human asks. |
| `ext.assistProviders` | — | Needs `assist`. `{ok, providers: [{id, kind, name, baseUrl, models, apiKey}]}`: the providers the human added for you and left on, each with its key (`null` when none is stored). Keys live in Ostia's encrypted store, are never in `settings.json`, never synced and never shown again; only the extension that runs the provider gets them (`ext.getAssistProviders()` in the SDK). |
| `ext.assistChunk` | `{requestId, text}` | Needs `assist`. One streamed delta of a `chat` answer (256 KiB max; a JSON chunk that doesn't fit the request's 1M-character budget is dropped whole). Returns `{live}`; stop streaming when it is `false` (the human stopped or closed it). |
| `ext.openTerminal` | `{command: string[], workspaceId?, afterPaneId?, cwd?, title?, waitMs?}` | Needs `shell`. Opens a **new** terminal pane right of `afterPaneId` (a pane id from `caller.paneId` or `pane.list`), else of the workspace's active pane (it becomes the first pane of an empty workspace), switches to that workspace, and runs `command` there once the shell shows its first prompt. Returns `{ok, paneId}`. `command` is an argv (1–64 strings, no control characters); Ostia quotes each argument for the shell, so pass data, never a shell string. `cwd` must be absolute. The command runs once, and never in an existing pane. Use it for things the human should watch or answer (sudo prompts), after `ext.confirm`. With `waitMs` (at most 600000) the call returns when that command ends instead, as `{ok, paneId, wait: {outcome, exitCode?}}`: `outcome` is `finished` (with the exit code), `closed` (the human closed the terminal first) or `timeout`. A pane opened beside the pane whose CLI call the extension is serving, while the human has no call open beside that pane, counts as that pane's child for reach; a `host: true` terminal never does. It never reads the terminal's output. |
| `ext.agents` | — | Needs `shell`. `{ok, agents}`: the names of the agents `ext.runAgent` can start. Names only; the command behind a name stays with Ostia. |
| `ext.runAgent` | `{workspaceId, agent, prompt, background?, continueFrom?, afterPaneId?}` | Needs `shell`. Opens a **new** terminal in that workspace, in its folder, and runs the named agent there with `prompt` as one argument once the shell shows its first prompt, exactly like `ostia agent run`. Returns `{ok, paneId}`, or `unknown-agent`, `not-opened`, `rate-limited`. `prompt` is 1–16000 characters; newlines and tabs are allowed, other control characters are refused. With `background: true` (API 3.3) the terminal opens as a background tab with the unread mark and the human's workspace, tab and focus stay where they are. With `continueFrom: <paneId>` (API 3.3, instead of `agent`) the new terminal continues the agent session of a pane you opened: Ostia reads that pane's session and builds the command itself, forking the session while a live pane holds it (`claude --resume <id> --fork-session <prompt>`, `codex fork <id> <prompt>`) and resuming it otherwise (`claude --resume <id> <prompt>`, `codex resume <id> <prompt>`), in the session's folder; you never name a session, a flag or a command, and nothing is typed into the old pane. `not-reached` (not a pane you opened), `no-session`, `resume-folder-missing`. With `afterPaneId: <paneId>` (API 7.4) the terminal opens as a normal tab right after that pane's tab, shown and focused, never inside a split tab, a `· workers` tab or a fork group, and never as the pane's child; `afterPaneId` is only the pane whose command this extension is serving right now (a CLI call or the palette's), another pane is `not-reached`, a pane of another workspace `unknown-pane`, and it cannot be combined with `background`. Start an agent only because the human asked: from your panel, where their click is the request (never from a command an agent can run), or after `ext.confirm`, or as a step of something the human enabled knowing that it starts agents. Offers and runs together are limited to 6 a minute. |
| `ext.exec` | `{workspaceId, command: string[], timeoutMs, maxOutputBytes?, dataDir?, env?}` | API 3.3. Needs `process`. Runs an argv with **no terminal**, in the workspace folder, with stdin closed and no `OSTIA_*` variable; inside the workspace's sandbox when it has one, and never unwrapped (`sandbox-unavailable`). `timeoutMs` is at most 600000; output is capped at `maxOutputBytes` (default 64 KiB, at most 1 MiB) per stream. `env`: up to 16 names matching `GRAPH_[A-Z0-9_]+` (nothing that changes how programs load or how a shell starts) of at most 4096 characters; the command gets the environment Ostia started with, without the discrete-GPU variables Ostia set for itself. `dataDir` is a folder inside your data folder (relative, no `..`, not a link) shown read-only to the command as `$OSTIA_EXEC_DIR`. `{ok, exitCode, signal?, timedOut, stdout, stderr, truncated, sandboxed}`; a killed command has `exitCode: -1`. Cancelling the request, the timeout and your process exiting end the whole process group (SIGTERM, SIGKILL 5 s later); Ostia quitting kills it at once. Refusals: `unknown-workspace`, `scratch`, `sandbox-unavailable`, `too-many` (8 at once), `spawn-failed`, `invalid-params`. `exec(opts, signal?)` in the SDK cancels with the signal. |
| `ext.sandboxDomains` | `{workspaceId}` | API 4.2. Read-only. `{ok, domains}`: the domains a sandboxed workspace allows (the human's global list, the workspace's and those allowed until restart), for a workspace one of your commands or your panel was called from. Never paths, secrets, ports or switches; nothing changes the list. Refusals: `not-reached` (no caller of yours in that workspace), `not-sandboxed`, `invalid-params`. |
| `ext.browse.readAt`, `ext.browse.entries`, `ext.browse.chunk` | `{ticket, offset, length}`, `{ticket, entries}`, `{ticket, data}` | API 6.1, need `file-contents`. The SDK's `BrowseFile` and sinks send these for you while a `browse` request is running; see [Browsing inside a file](#browsing-inside-a-file). A call with no live ticket answers `unknown-ticket`. |
| `ext.phoneScreens.listen`, `ext.phoneScreens.request`, `ext.phoneScreens.ask` | `{}`, `{linkId, method, params?}`, `{sessionId}` | API 6.2, need `phone-screens`. Take phone screens, send a request to one, or ask phones to start a session; see [Phone screens](#phone-screens). |
| `ext.phoneScreens.askFor` | `{sessionId, pane, reason, agent?}` | API 6.4, needs `phone-screens`. Passes on an agent's request for the phone's screen; see [Phone screens](#phone-screens). |
| `ext.busSend` | `{to, text}` | API 3.3. Needs `send-other-pane` and `all-workspaces`. Puts `text` (at most 16000 characters) into that pane's bus inbox as `ostia bus send` does, with your extension id as `from`: an agent blocked in `ostia bus wait` gets it at once (`state: 'delivered'`), otherwise it stays queued until the agent takes it (`state: 'queued'`, with `pending` saying why: `working`, `idle-no-wake`, `hibernated`, `hooks-off` or `no-agent`) and fails after 24 hours or when the pane closes. Nothing is typed. `{ok, id, state, pending?}`; the manager pane and an unknown pane are `unknown-pane`, and a receiver with 200 undelivered messages is `inbox-full`. |
| `ext.wakePane` | `{paneId, waitMs?}` | API 3.3. Needs `type-other-pane` and `all-workspaces`. Wakes one hibernated agent pane exactly as `ostia pane wake` does: Ostia types only that pane's stored resume command; you pass a pane id and nothing else. `{ok, outcome}` with `woke`, or with `waitMs` (at most 120000) `started`, `timedOut`, `closed` or `resume-failed`; `not-hibernated`, `session-conflict`, `unknown-pane` (also for the manager pane). |
| `ext.ask` | `{workspaceId, question, context?, choices?, mode?, timeoutS?}` | API 3.3. Needs `drive-self`. Puts a question on the same list as `ostia ask` in the window that holds the workspace, labelled with your extension's name: `question` one line (clipped to 500), `context` up to 4000, `choices` up to 12 labels, `mode` `text`, `single` or `multi`. Waits until the human answers, dismisses it, `timeoutS` passes, you cancel the request (`ask(opts, signal)` in the SDK) or your connection closes; the last two withdraw it. `{ok, outcome: 'answered', reply: {choices, text}}` or `{ok, outcome: 'dismissed' \| 'timeout' \| 'closed'}`; `too-many-questions` (3 open per workspace), `rate-limited` (6 a minute), `unknown-workspace`. Only the human answers it, or a paired phone with `respond`; no command answers it. |
| `ext.mcpCall` | `{server, tool, input}` | API 4.1. Needs `mcp`, a capability no extension holds by default and the human grants (never the manager's). Calls one tool of an MCP server the human set up in Settings and left on, connecting the server first when it is not connected yet; `input` is the tool's arguments object. `{ok: true, text, structured?}` (`text` capped as for chat tools; `structured` when the tool returned structured content) or `{ok: false, error}` with the host's message (`This MCP server is not connected.` for a server that is off or unknown, `This MCP tool is turned off.`, a timeout after 120 s). You never get the server's command line, URL, headers or secrets, and nothing here adds, starts or changes a server. `mcpCall(server, tool, input, signal?)` in the SDK cancels with the signal. |
| `ext.mcpServers` | — | API 4.1. Needs `mcp`. `{ok, servers: [{name, state, tools}]}` for the servers that are on, connecting them first; `tools` holds the names of the tools that are on. Names and states only. |
| `ext.agentTool` | `{sessionId, toolCallId, name, input}` | API 6.4. Only the built-in `agent` extension: another extension gets `{ok: false, error: 'invalid'}`. Hands one tool call of the Agent's model to the window that owns the session (the human's click answers it, through the approval card for anything that edits, runs or opens). `{ok: true, output}` or `{ok: false, error, denied?}`; main redacts `output` and `error` first and answers an error instead when the scan fails. `agentTool(call, signal?)` in the SDK cancels with the signal. |
| `ext.agentEvent` | `{sessionId, event}` | API 6.4. Only the `agent` extension: sends a text delta, tool call, tool completion, error or end of turn to the window that owns the session. `agentEvent(sessionId, event)` in the SDK. |
| `ext.agentComplete` | `{system, input}` | API 6.6, needs `agent-complete`, and answers only the built-in `skills` extension (any other caller gets `skills-only`). One answer from the Agent model the human set up in `agent.providers` (the first model of the first server), with no session, tools or history: `{ok: true, text}` or `{ok: false, error}` (`skills-only`, `no-model`, `redaction-failed`, `invalid`, `too-long`, `failed`, `unavailable`). `system` is at most 8,000 characters and `input` 60,000; main redacts both before they leave, and sends nothing when the scan fails. At most 20,000 characters come back. Send only text you already redacted and hold the human's consent for; the answer is data, never an instruction to follow. `agentComplete(opts, signal?)` in the SDK cancels with the signal. |
| `ext.offerToAgent` | `{workspaceId, text, label}` | Asks the human, in Ostia's own dialog in the window that holds the workspace, whether to send `text` to one of the agents running there (the same list as Ostia's other Send to agent pickers). Nothing is sent until the human picks an agent and clicks Send; Ostia then pastes the text at that agent's prompt and **never presses Enter**. `text` is one line of 1–2000 characters and `label` (shown in the title) one line of 1–120, both without any control character. Returns `{ok, sent: false}` when the human declined or did not answer within 2 minutes, `{ok, sent: true, paneId}` with the pane they picked, or `unknown-workspace`, `busy` (your previous offer still waits), `rate-limited`. Needs no capability. |
| `ext.requireCallerCaps` | `{paneId, caps, reason}` | API 7.4. Asks for the capability a command line caller lacks, through the same card as any other `ostia` call. `caps` is `['all-workspaces']` only; `reason` is one line of at most 160 characters that the card shows after your extension's name; `paneId` is the pane whose CLI call you are serving right now (`caller.paneId` with `caller.kind === 'pane'`). Returns `{ok: true}` once the pane holds the capability (granted before or answered on the card), or `denied`, `not-approved`, `sandboxed` (a sandboxed pane is refused before any card), `needs-elevation` (no one to ask), `not-reached` (not a CLI call you are serving, never a palette call), `invalid-params`. The extension never holds the grant and the answer is never remembered by Ostia for you. Needs no capability. |
| `ext.playbookEnabled` | — | API 7.4. Built-in extensions only. `{ok, enabled}`: whether the human turned on the playbook with your extension's id in Settings › Agents › Playbooks. Only your own id can be asked; anything else about playbooks stays with Ostia. Needs no capability. |
| `ext.focusPane` | `{paneId}` | Shows that pane: switches to its workspace and window and focuses it. Only for a pane you opened (`ext.openTerminal`, `ext.runAgent`), one the human picked for your offer, or (API 3.1) a pane that ran one of the commands your `contributes.agentHooks` name while you hold `agent-plugin`; any other pane is `not-reached`, a closed one `unknown-pane`. Ostia remembers the panes for one run: after it restarts, a pane counts again from its agent's next hook. Call it only on the human's click in your panel. |
| `ext.redact` | `{texts: string[]}` | API 3.1. `{ok, texts}`: the same texts with secrets replaced, by Ostia's own scanner and the human's `privacy.redaction` setting and patterns (with redaction off they come back unchanged). At most 16 texts of 16,000 characters each. Use it before you store text an agent or the human produced (a prompt line, a command, a closing message). When the scan fails the answer is `redaction-failed` and never the text: store nothing for it. `ext.redact(texts)` in the SDK returns the texts or `null`. |
| `ext.openFolder` | `{workspaceId, host, path}` | Shows a folder that lives somewhere else (another machine, a container) in that workspace's Files, served by you. Ostia first asks the human in its own dialog, naming you, `host` and `path`; Cancel is the default. Returns `{ok, folderId}`, or `denied`, `unknown-workspace`, `sandboxed`, `scratch`, `invalid-params`, `too-many` (8 per workspace). `host` is a label for the human (`[A-Za-z0-9._@:-]`, at most 330 chars); `path` is absolute, without `..` or control characters. Mark the command that calls it `interactive`. See [Remote folders](#remote-folders). |
| `ext.closeFolder` | `{folderId}` | Closes one of your own folders. `unknown-folder` for anything else. |

`whoami` works too. Pane-scoped methods (`command.exec`, `pane.info`, `bus.*`, …) are refused
for extension identities, except the targetable ones below.

### Acting on a pane: `targetPaneId`

The browser methods (`browse.*`, as the `ostia browse` CLI uses them), the read-only process
methods (`process.list|info|output`) and `pane.setAttention` accept an extra
`targetPaneId` (an external pane id) from an extension. Ostia then runs the method as if the pane
you named had called it: `browse.read` without `paneId` reads that pane's workspace's browser,
`process.list` lists the processes of that pane's workspace, `pane.setAttention {state, message?}`
sets that pane's attention (`waiting`, `done`, `working`, `error`, `clear`), which rings like any
other signal.

`process.run`, `process.kill` and `process.restart` type into a terminal, so they are for panes
only, like `pane.input` and `pane.read`. To run a command the human can watch, use
`ext.openTerminal`.

Your extension needs both the method's own capability (`browse`, `process`, `drive-self`) and
`all-workspaces` in its manifest, approved by the human. Why `all-workspaces`: an extension has
no pane of its own, so every pane is another pane, and acting on another pane always needs it.
Errors: `needs-elevation: <cap>`, `needs-target: targetPaneId` (you left it out),
`unknown-target: <id>` (not a pane). The SDK has `callAs(paneId, method, params)` and
`setAttention(paneId, state, message?)`. Pick element (`browse.pick`) is not available to
extensions: it waits for the human's click.

The SDK (`packages/extension-sdk/src/client/index.ts`, `connect()`) wraps all of this: `setPaneChip`,
`clearPaneChip`, `getSettings`, `setSetting(key, value)`, `onSettingsChanged(values => …)`, `numberSetting(values, key,
fallback, {min, max})` and `booleanSetting(values, key, fallback)` (read a value, clamped, with
a fallback), `openPanel(workspaceId?, path?)`, `notifyPanel(title, body?, path?)`,
`onPanel((caller, path) => ({url}))`, `callAs`, `setAttention`, `listAgents()`,
`runAgent({workspaceId, agent, prompt})`, `offerToAgent({workspaceId, text, label})` and
`focusPane(paneId)`, `exec(opts, signal?)`, `busSend(to, text)`, `wakePane(paneId, waitMs?)`,
`requireCallerCaps(paneId, caps, reason)` and `playbookEnabled()` (API 7.4),
`sandboxDomains(workspaceId)` and `ask(opts)` (these answer with a result instead of throwing), `redact(texts)`, and
`parseAgentStop(agent, stdin)` (API 3.3), which reads a `Stop` hook's input into
`{sessionId, turnId?, message?, backgroundWork}` (the closing message is `last_assistant_message`;
no transcript is read; input that is not JSON or over 1 MiB gives `null`).

### Requests Ostia sends you

| Method | Params | Reply |
|---|---|---|
| `ext.command` | `{command, args, caller}` | A result (below). 30 s timeout, 10 min for an `interactive` command. The CLI waits as long as Ostia does. |
| `ext.assist` | `{point, requestId, input, model?}` | The result for that point (below), or `{error, message?}` with `error` one of `unavailable`, `rate-limited`, `failed`, `cancelled`, `invalid`, `busy`. Carries a jsonrpc cancellation token: stop work when it fires. 30 s timeout, 5 min for `chat`. `model: {provider, model}` names the model the human chose when you reported `providers`; serve the request with exactly that one. |
| `ext.assistModels` | `{action: 'list', provider?}` or `{action: 'load' \| 'unload', id, provider?}` | Sent only to an extension whose last `ext.setAssistStatus` said `models: true`, when the human opens or acts in Settings → Assistant. `provider` is the id of one of the providers you reported: `list` then answers what that provider has, which is what the human picks from when adding its models. `list` replies `{lifecycle, models: [{id, name?, description?, installed?, loaded?, busy?, idleSecs?}], error?}` (64 models, normalized by `normalizeAssistModels`); `lifecycle: true` shows Load/Unload. `load`/`unload` reply `{ok: true}` or `{ok: false, error}`. 15 s timeout for `list`, 5 min for a load. The SDK wraps it: `onAssistModels({list(provider?), setLoaded(id, loaded, provider?)})`. |
| `ext.agent` | `{op: 'open', sessionId, cwd, tools, providers, model?, context?}`, `{op: 'prompt', sessionId, text}`, `{op: 'complete', system, input, providers, model?}` (API 6.6, replies `{ok: true, model, text}`) or `{op: 'abort' \| 'close', sessionId}` | Sent only to the built-in `agent` extension (`onAgent(handler)` in the SDK), by the Agent pane. `open` creates or resumes the session and replies `{ok: true, model, history, rules}`; `context` (API 6.6) is the rules text the human's Rules chip lets through, appended to the session's system prompt, and `rules` is how many it holds; `prompt` starts a turn and replies at once, the turn's progress arriving through `ext.agentEvent`; `text` is already redacted. 60 s timeout. |
| `ext.panel` | `{caller, path?}` | `{url}` for a `"url"` panel: must be `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`. `path` is present when the panel is opened or navigated to a path (`ext.openPanel {path}`, a notification with `openPanel: "/path"`); return the URL for it on the same origin. |
| `ext.files` | `{op, folderId, root, path, content?, baseVersion?}` | One file operation in a folder you opened with `ext.openFolder` (`ext.onFiles` in the SDK). `root` is the folder and `path` an absolute path inside it; Ostia has already refused anything outside. See [Remote folders](#remote-folders). 30 s timeout. |
| `ext.browse.list`, `ext.browse.read` | `{ticket, kind, size, limits}`, `{ticket, kind, size, index, max, limits}` | API 6.4. List the entries of a file or read one entry of it for a `browse` kind (`onBrowse` in the SDK). Ostia gives a ticket and the size, never a path. |
| `ext.phoneScreen.offer` | a link: `{linkId, sessionId, width, height, density, rotation, level, limitSec, endsAt, overlayHeight, label, agent?, device: {id, name}}` | API 6.2, only to the extension that listens for phone screens. `{accept: true}` takes the link; anything else, or no answer in 5 s, refuses it. |

And the notification `ext.event {type, payload}`:

| Event | Payload |
|---|---|
| `pane.created`, `pane.closed` | `{paneId, workspaceId}` |
| `command.started` | `{paneId, workspaceId, cwd?}` |
| `command.finished` | `{paneId, workspaceId, cwd?, exitCode?}` |
| `cwd.changed` | `{paneId, workspaceId, cwd}` |
| `pane.attention` | `{paneId, workspaceId, state}`: API 4.1. A pane's attention changed: `working`, `waiting`, `done`, `error` or `cleared`. Sent only when the state changed, never with the agent's message text. |
| `pane.lifecycle` | `{paneId, workspaceId, state}`: API 4.9. A pane's terminal was hibernated (`hibernated`) or started again after hibernating (`woken`). Sent only for workspaces you have a caller in, or any unsandboxed one when you hold `all-workspaces`. |
| `bus.message` | `{id, from, to, kind, phase}`: API 4.9, needs `read-bus`. A bus message between panes, Ostia or an extension: `from` and `to` are `{id, workspaceId?}` (`workspaceId` only for a pane), `kind` is `message` or `task`, `phase` is `queued` (left in the receiver's inbox), `delivered` (the receiver's agent took it) or `failed` (it expired after 24 hours or its pane closed); one message sends one event per phase, with the same `id`. Metadata only: never the text, and never a quiet system nudge. Like `pane.lifecycle`, it reaches you only for workspaces you have a caller in (or any unsandboxed one with `all-workspaces`); an endpoint in a workspace you cannot see comes with an empty `id`, and a message with no visible side is not sent. |
| `focus.changed` | `{focused}`: whether any Ostia window has focus. Assume focused at start; use it to pause polling while the user is elsewhere. |
| `notification` | `{title, body?, from}` |
| `workspace.closed` | `{workspaceId}`: a workspace closed in any window. Release what you hold for it. API 4.2. |
| `settings.changed` | `{values}`: all your settings after the human changed one, or after the human changed one of your secrets (read it again with `ext.getSecret`). Sent without `ext.subscribe`. |
| `connections.changed` | `{}`: the human added, changed or removed one of your connections; read them again with `ext.connections`. Sent without `ext.subscribe`; `onConnectionsChanged(handler)` in the SDK. |
| `locale.changed` | `{locale}`: the human changed the language (`ext.onLocaleChanged` in the SDK). Sent without `ext.subscribe`. |
| `assist.providers.changed` | `{providers}`: the same list `ext.assistProviders` returns, after the human added, changed, switched or removed one of your providers or its key (`ext.onAssistProvidersChanged` in the SDK). Sent without `ext.subscribe`, only to an extension granted `assist`. |
| `folder.closed` | `{folderId}`: one of your remote folders went away because the human closed it in Files or its workspace closed (`ext.onFolderClosed` in the SDK). Sent without `ext.subscribe`. API 1.11. |

The listener for phone screens also gets the notifications `ext.phoneScreen.frame {linkId, header, jpeg}` (`jpeg` base64) and `ext.phoneScreen.event {linkId, kind, payload}` (API 6.2, see [Phone screens](#phone-screens)).

`paneId` is always the external id agents see (`ostia whoami`).

### The caller

Every command and panel request carries who is asking:

```ts
{ kind: 'pane' | 'user', paneId?, workspaceId?, workDir?, cwd?, locale?, sandboxed?, remote?, humanPrompt?, capabilities: string[] }
```

- `pane`: an agent or shell via `ostia`, both `ostia <verb> <command>` and the palette id form
  `ostia <extId>.<command>` (which takes no `--workspace`); `capabilities` are that pane's;
  `locale` is the human's language ("Translations"), so text you show the human can follow it.
- `user`: the palette (capabilities = the command's own declared ones; `paneId` is the focused
  pane, and a chip click's pane) or your panel request (the SDK's panel server fills `locale`
  from the page's query).

Use `workDir` for project-scoped data (it is the workspace's anchor directory, possibly `~`).
`cwd` is the live shell directory of the calling pane (CLI) or of the active pane (palette) when
that is a terminal; use it for "where the user is" (a tool that needs the repository finds it from there).
Panel requests carry no `cwd`; derive one from `workspace.list` + `pane.list` if you need it.
Enforce conditional rules yourself from `capabilities`, for example refuse a write outside the
workspace's project unless the caller holds `all-workspaces`.

`sandboxed` is `true` when the caller's workspace is sandboxed. Your process runs
outside every sandbox, so refuse such a caller anything the sandbox would have kept from it: the
SSH extension gives it no host list and opens no session.

`remote` is `{host, cwd}` when the shell in the calling pane last reported a folder on another
machine: an ssh session whose shell sends OSC 7 with its host name. It is absent for a
local pane, and it is what that shell said, nothing more: use `cwd` as a path to offer the human,
and never take `host` as proof of where a connection goes.

`humanPrompt` (API 6.6) is a string, set only for the call of one of your own `UserPromptSubmit` hook commands (`contributes.agentHooks`, with `agent-plugin` approved) when Ostia itself saw every character of the line just submitted in that pane come from the human (keys they pressed or a paste they made, on the desktop or on their paired phone, typed in a terminal or sent as an agent prompt). It is the text Ostia saw typed, with no more than whitespace trimmed; it is empty-and-absent for a line with no text (a menu choice), a line edited with the cursor or word-delete keys, or a line any other source touched (`ostia pane send`, an agent, a command or reference Ostia typed, a paste of a dropped file). Ostia hands it out once per submitted line and per extension, within 10 seconds, and keeps nothing else. A process in that pane can still call your command, so compare `humanPrompt` with the hook's own `prompt` and keep nothing when they differ: a forged call can only consume the claim, not supply the text.

### Remote folders

An extension that can reach files somewhere else can show them in Files and the
editor without Ostia knowing how it gets there. The built-in SSH extension does it over ssh.

1. Call `ext.openFolder({workspaceId, host, path})` from a command the human ran. Ostia asks the
   human and, on Open, shows the folder as its own section in Files, marked Remote with `host`.
2. Answer `ext.files` (`ext.onFiles(handler)`):

| `op` | You get | You return |
|---|---|---|
| `list` | `path` of a folder | `{ok: true, entries: [{name, dir}], truncated?}` |
| `stat` | `path` | `{ok: true, kind: 'file' \| 'dir', version?}` |
| `read` | `path` of a file | `{ok: true, content, version}`: UTF-8 text, at most 2 MiB |
| `write` | `path`, `content`, `baseVersion` | `{ok: true, version}` |

   A failure is `{ok: false, error}` with `error` one of `not-found`, `not-file`, `not-dir`,
   `too-large`, `binary`, `changed`, `denied`, `outside`, `unavailable`, `failed`.
3. Release what you hold when `folder.closed` arrives (`ext.onFolderClosed`). Ostia also drops
   your folders when your process exits.

`version` is your own token for a file's content (`[A-Za-z0-9._:-]`, at most 80 chars; a
checksum or `mtime:size`). A `write` carries the version the editor read as `baseVersion`, or
`new` for a file that did not exist, or `any` when the human chose to overwrite: refuse with
`changed` when the file is no longer at `baseVersion`. Ostia polls `stat` for open files and
compares versions to notice a change.

Ostia keeps the confinement on its side and trusts neither you nor what you reach: only the
window that owns the workspace may ask; a path must be absolute, normalized and inside `root`;
a listing keeps at most 5000 plain names (no `/`, no control characters, 255 chars); content
with a NUL byte is `binary`; anything malformed is `failed`. Check paths again yourself against
whatever really resolves them (symlinks). A remote file never becomes a local path: it has no
language server, no external editor, no "open with default app", and its pane is not restored.
A scratch or sandboxed workspace has no remote folders.

### Phone screens

API 6.2. A phone whose human started a screen session in the companion opens a link to Ostia; Ostia
offers it to the one extension that listens for phone screens and relays between the two. Nothing
here starts a session: only the phone's human does, on the phone, every time.

- `phoneScreens.listen({offer, frame?, event?})` in the SDK makes you the listener. It needs
  `phone-screens`, a capability no extension holds by default and the human grants (never the
  manager's). One listener at a time: a second answers `busy`.
- `offer(link)` returns whether you take the link. `link.level` is `view` or `control`; `endsAt`
  is when the session ends, in ms since the epoch.
- `phoneScreens.request(linkId, method, params?)` sends one of `phone.capture`, `phone.stream`,
  `phone.tap`, `phone.swipe`, `phone.type`, `phone.key`, `phone.launch`, `phone.apps`,
  `phone.tree`, `phone.stop` (the companion's network contract has their params and results).
  `{ok: true, data}` is the phone's result; `{ok: false, error, data?}` carries the phone's error
  code (`paused`, `blocked-app`, `declined`, …) or Ostia's: `unknown-link`, `unknown-method`,
  `view-only` (an input request on a `view` link), `timeout` (no answer in 75 s), `link-ended`.
- `frame({linkId, header, jpeg})` gets the screen while `phone.stream` runs, at most 5 a second;
  `header` is `{seq, width, height, screenWidth, screenHeight, blocked}`.
- `event({linkId, kind, payload})`: `kind` `state` (the phone's `screen.state`), `foreground`
  (`screen.foreground`) or `ended` (`{reason}`: `closed`, `revoked`, `caps-changed`, `time-limit`,
  `no-controller`). A link ends when the phone closes it, the device is revoked or loses a cap,
  5 s after `endsAt`, or when you stop, are disabled or lose `phone-screens`.
- `phoneScreens.ask(sessionId)` asks every phone allowed to notify to start a session for that
  workspace (the phone shows a notification; its human decides). Call it only from the human's
  click.
- `phoneScreens.askFor({sessionId, pane, reason, agent?})` (API 6.4) passes on an agent's request:
  `pane` is the asking agent's pane (it must be in `sessionId`, never the manager), `reason` one line
  of at most 300 characters the phone shows, `agent` `claude` or `codex`. Phones get
  `screen.requested` with `by: 'agent'` and a `requestId`, and their human decides. The call waits
  and answers `{ok: true, data: {outcome}}` with `started` (the human started a session for it),
  `declined` with `reason` `denied` (the phone's human said no or did not answer there within 60 s), `off` or `unsupported` (phone control is off on that phone), or
  `no-answer` after 2 minutes, or as soon as every asked phone that has not declined disconnects or is unpaired. It goes to each phone that may be notified and has no request of its own waiting; `started` comes from the first of them that starts a session for that workspace, `declined` only once every asked phone still connected declined. Refusals: `busy` (a request for that workspace waits, or every phone waits on one), `cooldown` (that workspace was declined less than a minute ago, or went unanswered less than 15 s ago), `no-phone`, `not-reached` (no caller of yours in that workspace), `not-an-agent`, `unknown-pane`, `invalid-reason`. Call it only
  for a request the agent made itself, from the agent's own pane.
- Ostia keeps no frame, request, result or event and logs none of them.

### Results

Return `{ok: true, text?, data?}` or `{ok: false, error, message?, data?}`. The CLI prints `text`
if present, else `data` as JSON, else `ok`; a failure goes to stderr with exit code 1, after its
`data` (if any) as JSON on stdout, so an agent can read a structured "no" (`ostia system install`
returns `{approved: false, command}` this way). The palette
shows failures as a failed command. Anything else you return is wrapped as `{ok: true, data}`.

Errors Ostia produces before reaching you: `unknown-extension`, `extension-disabled`,
`unknown-command`, `needs-elevation` (message = the missing cap), `extension-unavailable`
(didn't start, crashed, timed out).

## Assist

Ostia draws the UI for four hook points and hands you the request; you own the model, the provider
and the prompts. Nothing is sent to you until the human acts: every request comes from something
they typed or clicked, and terminal output only when they switched a context chip on or asked to
explain a failed block. Ostia normalizes each request before you see it (size caps, known fields)
and each result before the renderer sees it.

| Point | Where the human sees it | `input` | Your result |
|---|---|---|---|
| `input` | The composer over an agent pane (Ctrl+Shift+J / ⌘J): a typo fix accepted with Tab, a prompt review on Ctrl+Enter | `{text, tasks: ('typos'\|'review')[], agent?}` | `{corrected?, review?: {score? (1-5), notes: string[] (≤5)}}` |
| `command` | The composer at a shell prompt, and `# <what you want>` in the input editor | `{query, cwd?, shell?, platform?}` | `{suggestions: [{command, description?}]}` (≤3, inserted at the prompt only when the human picks one, never run) |
| `completion` | Ghost text in the editor, accepted with Tab | `{path, language, prefix, suffix, neighbors?: [{path, text}]}` | `{text}`: only the insertion at the cursor |
| `terminal` | Ghost text continuing the command in the input editor at a shell prompt, accepted with Tab or → | `{line, cwd?, shell?, platform?, history?: [{command, exitCode?}], context?: [{label, text}]}` (never terminal output) | `{text}`: the rest of the line (Ostia keeps the first line only) |
| `chat` | The chat pane, Ask in the palette (Tab), and "Explain error" on a failed block | `{messages: [{role, content, tools?}], context: [{kind, label, text, path?, startLine?, endLine?}], tools?: [{name, description, inputSchema}]}`. A context item that comes from a file (the editor selection, the open file, an attached file) carries its absolute `path`, and a selection its 1-based line range, so the model can aim the read and edit tools at it | `{text}`. While producing it, send each AI SDK `UIMessageChunk` (`streamText(...).toUIMessageStream()`) JSON-encoded as one `ext.assistChunk`; Ostia feeds them to `useChat` |

The SDK wraps it: `onAssist(async (point, input, {requestId, signal, chunk, model?}) => result)`,
`setAssistStatus(status)`, `getSecret(key)`, and `throw new AssistFailure('rate-limited')` for a
typed failure. Debounce and rate-limit on your side too; Ostia debounces keystrokes and cancels
stale requests.

Unless the human turned secret redaction off (Settings → Privacy), the text of every request has
detected secrets replaced with `[redacted:<kind>]` before it reaches you (`[redacted:github]`,
`[redacted:assignment]`, …). Pass the marks through as they are; never ask the human for the
original, and do not treat a mark as an error. A typo correction made from a redacted draft is
dropped by Ostia.

### Providers and models

The human configures the assistant only in Settings → Assistant, and chooses there which model
answers the chat and which one the fast features use (typo fixes, prompt review, command
suggestions, completions); each chat can pick another chat model in its composer. Ostia routes a
request to the extension that owns the chosen model, and only while that extension is enabled,
granted `assist` and reported the point `ready`. When the chosen extension has the feature off,
nothing answers: Ostia never falls back to another extension. With no choice made, the first model
offered is used.

An extension is one of two shapes:

- **One model.** Report `status`, a `label` and nothing else. You appear as one entry in the
  model lists, and requests reach you without `model`.
- **Several providers and models.** Report `providers` and, to let the human add providers of
  your kinds, `kinds`. Ostia then owns the list: for each provider the human adds it stores the
  kind, a name, a base URL, whether it is on and the model ids the human added (in
  `settings.json` under `assistant.providers`, synced without keys), keeps its API key encrypted
  on this computer, and hands you the enabled ones through `ext.assistProviders` and
  `assist.providers.changed`. Report each of them back in `providers` with its state, so
  Settings can say "Ready", "Needs an API key" or "Not reachable" next to it. A provider you
  report that the human did not add (a local runtime you find by yourself) shows as a fixed
  entry with your extension's name. Answer `ext.assistModels {action: 'list', provider}` so the
  human can pick model ids instead of typing them.

`runAssistExtension({catalog})` from `…/assist` does all of this for a `ProviderCatalog`
(`kinds`, `keyRequired`, `title(kind, locale)`, `defaultBaseUrl(kind, env)`, `create(kind,
endpoint, apiKey)`); `runAssistExtension({catalog, provider: '<kind>'})` runs one fixed provider
at the address in your own `baseUrl` setting and offers every model it lists as installed.

### Chat tools

Ostia, not your extension, runs the chat's tools, so a chat extension gains no power beyond the
public API. If you report `tools: 'native'` or `tools: 'prompted'` on the `chat` status, a chat
request may carry:

- `tools`: the tools the human left on for that chat, each `{name, description, inputSchema}`
  (a JSON schema object; names match `[A-Za-z0-9_-]{1,64}`, up to 64). Built-ins are
  `read_file`, `list_directory`, `search_files`, `terminal_context`, `git_status`, `load_skill`,
  `propose_command`, `edit_file` (exact-text replacements in an existing file:
  `{path, edits: [{old_text, new_text, replace_all?}]}`), `write_file` (a new file or a whole
  file), `open_file`, `open_url`; tools from the human's MCP servers are named
  `mcp__<server>__<tool>`.
- `messages[].tools` on assistant turns: the calls of that step with their outcome,
  `{id, name, input, state: 'done' | 'error' | 'denied', output?, error?}` (`output` is text,
  at most 32 000 characters). A request may end with such a turn instead of a user turn.

Declare the tools to your model without executing them (the AI SDK's `dynamicTool` with
`jsonSchema(inputSchema)` and no `execute`) and stream as usual: when the model calls one, the
`tool-input-available` chunk ends your step and your reply. Ostia then runs the call (asking the
human when the tool acts: commands every time; file edits one by one in the chat's Ask mode, and
in its Write mode only when the file is outside the workspace folder, behind a symlink or has
unsaved edits; opening files or URLs and MCP tools until the human allows them for the chat;
reads outside the workspace folder once), records it in the conversation, and sends you a new
request with the outcome, up to 8 rounds per question. An edit fails with a plain message when
its `old_text` is missing or not unique, or when the file changed on disk since the model read
it; the mode is the human's choice in the composer and no request tells you which one it is.
Treat `denied` as the human's answer, not an error to retry. Skip `tool-input-delta` chunks if
you like; Ostia uses only the complete input. A model without native tool calling still works:
describe the tools in its prompt and turn the calls it writes into the same tool-call chunks
(the built-in assistant does this with `@ai-sdk-tool/parser`'s Hermes middleware plus a
`tool_code` fallback for Gemma), and report `'prompted'`. Report nothing when tools can't run at
all, so Ostia never offers them.

## The CLI

```
ostia ext list                            enabled extensions and their commands
ostia <id> <command> [args...]            run a command
```

Arguments arrive as `args = {argv: [...], stdin?}`. Parse `argv` however you like. `ostia docs`
appends every enabled extension's commands (from `usage`) to the core help, so agents discover
you there.

## Panels

A panel is your page in a sandboxed `<webview>`, shown in the **right side panel** of the window: one panel at a time, its button in the top bar (the manifest `title` names the button and the side panel; Ostia draws no title row, so your page should not repeat it), left of the work area's split tree and never a pane or a tab. The human's button replaces the shown panel in the same place, or hides the side panel when the panel is already shown. Ostia keeps up to three panels alive per window (least recently shown first out); a hidden one keeps its page, an evicted one loads again at its last `path`. API 6.3: when Ostia hides a kept panel (another panel shown, the side panel closed) or shows it again, it dispatches `ostia-panel-visibility` with `{detail: {hidden}}` on the page's `window` (`onPanelVisibility(cb)` in `…/panel`); a hidden page still reports itself visible to the browser, so stop polling and streams on this event. The page is per workspace: it follows the window's active workspace, and in a sandboxed workspace Ostia loads it only after the human chooses Show there. The page is sandboxed as follows:

- its own partition (`ostia-ext-<id>`), no preload, no Node, no `window.ostia`, permissions denied;
- it may only show your `file://` html (file entry) or the loopback origin you returned (url
  entry); other navigations are blocked and `window.open` goes to the OS browser for http(s);
- it talks to **your process**, never to Ostia directly — serve an API next to the page.

The built-ins run a small HTTP server on `127.0.0.1:0` (`packages/extension-sdk/src/client/panelServer.ts`,
`startPanelServer`): the panel URL carries a per-run secret, `/api` requires it in a header,
requests with a foreign `Host` or `Origin` are refused, and `/events` pushes "changed" over SSE
so the panel updates when an agent edits data from the CLI. Do the same if your panel has data.

A **path** addresses a page inside your panel: it starts with a single `/`, may carry `?query`
and `#hash`, and has no spaces, control characters or backslashes. For a file panel it is a file
in your extension directory (`/card.html?id=4`), and anything that resolves outside it is
refused. For a `url` panel Ostia hands the path to your process in `ext.panel` and you return the
full URL (keep your secret in it). Either way the result must pass the same check as any panel
URL. Navigating keeps the existing panel and webview.

The panel kit (`…/panel` and `panel.css`) draws the parts every panel repeats, in Ostia's own look: `quietButton(label, onClick, strong?)` is a borderless text button for the actions inside a section; `emptyState(text, action?, attrs?)` is one muted line with an optional inline action (the text carries its own punctuation); `listRow({title, meta?, detail?, actions?, attrs?})` is a plain row with its badge or state in `meta`, a second line in `detail` and its buttons under it. Their styles are the `.ostia-page` (the full-height column a panel's root uses), `.ostia-spacer` (a flex filler that pushes the rest of a row to the end), `button.quiet` (with `.strong`), `.ostia-empty` and `.ostia-row*` rules in `panel.css`, so a panel defines none of these itself. The page draws no toolbar, tab strip or close button: Ostia draws that row above it.

## Panel toolbar

(API 7.0.) Every right side panel gets a toolbar row drawn by Ostia, in the panel container above your page, never inside it, so nothing in your page can cover or replace it. From left to right it shows your tabs, or your `panel.title` when you declare none, then your actions, then a close button (`Close <panel title>`) that hides the panel. Your page starts under the row, so `100vh` in the page is the page's own height.

Declare what the row shows in the manifest: `contributes.panel.toolbar = {tabs: [{id, title}], actions: [{id, title, icon}]}`, up to 6 of each. The first tab is shown until your page says otherwise. Titles go through your locale catalogs like `panel.title`, under `panel.toolbar.tabs.<id>.title` and `panel.toolbar.actions.<id>.title`. Actions are icon buttons with `title` as their tooltip and name.

Set the runtime state from the page with `setPanelToolbar({tab?, back?, badges?, disabled?, hidden?})` from `…/panel`. It replaces the whole state each time (identical calls are skipped), and an empty state clears it. `tab` is the shown tab id; `badges` maps tab ids to a positive count (up to 999) drawn after the tab title; `disabled` and `hidden` list tab or action ids. `back` (up to 60 characters) turns the row into a sub-screen row: a Back arrow and that title replace the tabs and the actions, and the close button stays. Ids you did not declare are refused. The state is kept per workspace and cleared when the workspace closes or your extension stops; Ostia forwards the call to the host as `ext.setPanelToolbar` through the panel server, so give `startPanelServer` a `toolbar: (state) => ext.setPanelToolbar(state)` handler.

Clicks come back to the page as events: `onPanelToolbar(cb)` calls `cb({kind: 'tab', id})` when a tab is chosen, `cb({kind: 'action', id})` for an action and `cb({kind: 'back'})` for the Back arrow. Ostia shows a chosen tab at once and your page confirms it with `setPanelToolbar`. A page with controls that are not tabs or icon actions (a select, a filter) puts them in its own first row.

Ostia injects its theme into the page as CSS custom properties once it loads and whenever the
theme changes: `--ostia-<token>` for every theme token (`--ostia-bg`, `--ostia-surface-1`,
`--ostia-fg`, `--ostia-fg-muted`, `--ostia-brand`, `--ostia-line`, `--ostia-attn-fg`, …) plus
`--ostia-font-ui` (the human's UI font), `--ostia-font-code` (their code font, the editor
font), `--ostia-font-size` and `--ostia-font-weight` (UI size and body weight), `--ostia-color-scheme` (`dark` or `light`; set
`color-scheme: var(--ostia-color-scheme, dark)` so scrollbars and native controls follow a light
theme) and `--ostia-motion-scale` (`1`, or `0` while the human has reduced motion on). Use them
with fallbacks (`var(--ostia-surface-1, #272a2d)`), as the SDK's own styles do;
`packages/extension-sdk/src/client/panel.css` is a ready base. It also defines Ostia's typography tokens, derived from those: `--font-ui`, `--font-code`,
the type scale (`--text-ui-xs|sm|base|lg` with `--text-ui-*--line-height`), the weights
(`--font-weight-normal|medium|semibold`, which step up from the human's body weight) and
`--tracking-caps` for all-caps labels; set type only through them. Ostia
embeds its bundled Inter Variable and Geist Mono Variable (latin) in the injected CSS, so a
panel gets them even though they are not system fonts. It also defines control radii
(`--radius-sm`, `--radius-md`), a `.switch` class that draws an `<input type="checkbox">` like
Ostia's switch, and motion tokens (`--motion-fast`, `--motion-base`, their `-exit`
pair, `--motion-panel`, `--motion-pulse`, `--motion-breathe`, `--motion-highlight`, `--ease-out`,
`--ease-in`, `--ease-in-out`), already multiplied by `--ostia-motion-scale`: time every
transition with them and animate only opacity and transform (hover may change colors), so a
panel follows Ostia's motion rules and its reduced-motion setting. Add the `.motion-reveal` class
to content right after the human opens it (a fade plus a 2 px move); never on first render.

### Resizable splits

`splitter()` (`packages/extension-sdk/src/client/splitter.ts`, styles in `panel.css`) stacks two
elements with a draggable divider between them, so the human sets how tall each part is:

```ts
import { splitter } from '@aurigax-ai/ostia-extension-sdk/splitter'
import { loadPanelSizes } from '@aurigax-ai/ostia-extension-sdk/panel'

await loadPanelSizes()
const body = splitter({
  key: 'list-details',
  label: 'Resize details',
  first: list,
  second: details,
  defaultFraction: 0.55,
  minFirst: 96,
  minSecond: 96,
  collapseSecond: true,
})
```

- The divider is a focusable `role="separator"` (`aria-orientation="horizontal"`,
  `aria-valuenow|min|max` in percent of the height, `aria-label` from `label`). Drag it with the
  pointer (captured, never selects text), move it 16px with ↑/↓, 64px with PageUp/PageDown, to
  the minimum or maximum with Home/End; double-click resets it to `defaultFraction`.
- Both minimums hold while the panel resizes. With `collapseSecond`, a panel too short for both
  shrinks `second` to its own height (`.ostia-split[data-collapsed]`; hide what shouldn't show,
  e.g. everything but a header) and hides the divider. `first` never shrinks below its own
  content when it isn't a scroll container, so content that grows (a textarea with
  `field-sizing: content`) pushes the divider down.
- Sizes are remembered per `key` as a fraction of the height, across reopen and restart:
  `startPanelServer` keeps them in `$OSTIA_EXTENSION_DATA/panel-sizes.json` (64 keys of
  `[A-Za-z0-9._-]`, values 0–1) and serves them at `/sizes` behind the panel secret;
  `loadPanelSizes()` reads them once, before the first split is drawn. `localStorage` doesn't
  work for this: the panel partition isn't persistent and its origin's port changes every run.
- Nothing animates the layout: only the divider's highlight fades in (opacity).

## File kinds

API 5.0. A file kind says which files an extension takes care of, by name. At least one of two roles is required. Its `view` role shows a file the human opened (from the Files tree, `ostia open`, a link or an archive) in its file view tab, read-only. Its `browse` role (API 6.1) lists and opens what is inside a file the human expands in Files, such as an archive. The shape of the view copies VS Code's custom editors (`contributes.customEditors` with a `CustomReadonlyEditorProvider`), with one difference: no code of yours ever runs outside the page, so a view needs no `main`, and nothing but the sandboxed page ever holds the file. `contributes.fileKinds` replaces `contributes.fileViewers`, which API 5.0 no longer reads.

```json
"contributes": {
  "fileKinds": [
    {
      "id": "office.spreadsheet",
      "displayName": "Spreadsheet",
      "selector": [{ "filenamePattern": "*.xlsx" }, { "filenamePattern": "*.ods" }],
      "view": { "entry": "sheet.html", "priority": "default" }
    }
  ]
}
```

- `id` is `<your id>.<name>`, with a name of lowercase letters, digits and dashes. For a kind with a `view`, the id is the view type: it is what a pane saves and what `files.viewerAssociations` names.
- `displayName` (at most 60 characters) names the kind in Open With. Translate it in your catalog as `fileKinds.<id>.displayName`.
- `selector[].filenamePattern` is `*.<extension>` (`*.tar.gz` works) or an exact file name, matched against the base name without case. Each kind has 1-32 patterns, and an extension has at most 64 in all. There is no matching by content.
- `view.priority` is `default` (the default) or `option`.
  - **`default`:** the view opens matching files.
  - **`option`:** the view is offered only in Open With, and as a toggle while the file shows as source.
- `browse` is an empty object (`{}`) that is there so options can be added later. It needs `main` and the `file-contents` capability, otherwise the manifest is refused with `contributes.fileKinds[i].browse needs a main process and the 'file-contents' capability`.
- `view.entry` is an `.html` file in your extension. The build bundles `<name>.ts` next to it into `<name>.js` and every `*.worker.ts` into `*.worker.js`.

**Which kind serves a file.**
- **View:** the choice below, which any number of extensions can take part in.
- **Browse:** exactly one provider serves a file. Only enabled kinds whose claim the human approved and whose extension holds `file-contents` take part. A built-in comes before a third-party kind, then the longest matching pattern wins (`*.tar.gz` beats `*.gz`), then the extension id. The others are not used: their row in Settings → Extensions says "Not used for *.zip: Archives handles these files." There is no setting to change this.

### Approval

A kind works only after the human approved it. The approval card lists each kind with its role and patterns, for example "Spreadsheet: shows *.xlsx, *.ods files" or "Zip archive: lists and opens what is inside *.zip, *.jar files you expand in Files", and shows `file-contents` with the other capabilities. Ostia records the approved claims (the id, the roles, the view priority and the sorted patterns). An update that adds a kind or widens a selector leaves the new claim unapproved: it does nothing, and the extension's row in Settings → Extensions shows it as waiting until the human approves it with Review permissions. Built-in extensions are approved automatically.

When the human opens a file that no enabled kind shows, the file view offers to install, enable or approve an extension that has a kind for it.

### Viewing a file

**Which view opens a file.**
1. The human's choice in `files.viewerAssociations` (`{"*.xlsx": "office.spreadsheet"}`, or `"default"` for Ostia's own view), set from Open With → "Always use for …".
2. Ostia's own views (images, PDF, Markdown) for their kinds.
3. The `default` views of enabled, approved kinds: built-in ones first, then by extension id.
4. The source.

Open With (in the file view, the tab menu and the palette) lists every view that matches, plus the source. If your extension is disabled or your page fails, the file shows as source with a note.

**Your page.** It is served from your extension folder at a per-document origin, `ostia-viewer://<token>/`. The guest is sandboxed harder than a panel:
- it has its own partition `ostia-viewer-<id>`, no preload, no Node and no `window.ostia`;
- every request outside its own origin is cancelled, and `connect-src 'self'` is in its CSP, so it cannot reach the network, your process or loopback;
- popups, navigation and downloads are refused. Unlike a panel, `window.open` does not reach the OS browser either.

Scripts, styles and workers load from your folder (`worker-src 'self'`). Ostia injects the same theme custom properties and fonts as for panels (see Panels), so start from `panel.css` (it is copied to `base.css`).

```ts
import { openViewerDocument, publishPortable, ViewerDocumentError } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { grid } from '@aurigax-ai/ostia-extension-sdk/grid'

const doc = await openViewerDocument()
const bytes = await doc.bytes()
doc.onDidChange(() => location.reload())
```

- `openViewerDocument()` returns `{name, size, modified, locale, viewType, bytes(), onDidChange(listener)}`:
  - `name` is the base name;
  - `locale` is the human's, for your `panelTranslator`.
- `bytes()` reads the file through Ostia's confined read, at most 50 MiB. It throws a `ViewerDocumentError` whose `problem` is `too-large` (with `size`), `gone` or `unreadable`.
- `onDidChange` fires when the file changes on disk.
- The file is untrusted input:
  - parse it in a worker with your own limits and a time limit;
  - never put its text into `innerHTML` without a sanitizer;
  - remember that a guest that runs out of memory only loses itself.
- `publishPortable({tables: [{name, columns, rows}]})` hands Ostia the text a table viewer shows, so the human can save the open file as a portable artifact. Ostia renders the tables itself, at most 256 tables of 5,000 rows and 1,000 columns, 16 MiB in all.

`grid({label, columns, rowCount, cell(row, column), rowLabels?, notes?})` returns `{element, destroy}`: a read-only grid of text that windows rows and columns with `@tanstack/virtual-core`, so a sheet of 100,000 rows and 1,000 columns keeps only the visible cells in the page. `columnName(index)` gives spreadsheet column letters. Its styles are the `.ostia-grid*` rules in `panel.css`.

### Browsing inside a file

API 6.4. A `browse` kind makes a file a folder in the Files panel. Ostia owns the tree: it keeps the `archive:` path, confines it to the real file, escapes names (control and bidirectional characters show as `\uXXXX`), refuses links and encrypted entries before it asks you, caches listings, and passes entries to the viewers other extensions provide. You turn bytes into raw entries and entry bytes. The built-in `archives` extension is the example: it serves zip, jar, tar, tar.gz and tar.zst.

```ts
import { BrowseError, connect, type BrowseProvider } from '@aurigax-ai/ostia-extension-sdk'

const zip: BrowseProvider = {
  async list(file, sink, { signal, limits }) {
    for (const entry of await readCentralDirectory(file, signal)) {
      const more = await sink.add({
        name: entry.name,
        dir: entry.name.endsWith('/'),
        size: entry.size,
        encrypted: entry.encrypted,
        link: entry.link,
      })
      if (!more) return { ok: true, complete: false }
    }
    return { ok: true, complete: true }
  },
  async read(file, index, sink, { signal, max }) {
    for await (const chunk of openEntry(file, index, signal)) {
      if (!(await sink.write(chunk))) return { ok: false, error: 'too-large' }
    }
    return { ok: true }
  },
}

const ext = await connect()
ext.onBrowse('zip', zip)
```

- `onBrowse(name, provider)` registers the kind `<your id>.<name>`; a name that is not a `browse` kind in your manifest throws. It also tells Ostia the process is up, so an extension with no commands, chips or panel is known as running when its first request comes.
- **You never get a path.** `file` is a `BrowseFile`: `size`, `readAt(offset, length)` and `stream(start?, end?)`. Ostia opened the real file once for this request and closes it when the request ends.
- **Block cache.** `readAt` takes any offset and length, but the SDK only asks Ostia for whole aligned 1 MiB blocks (the last one short), keeps at most 8 of them, and serves everything else from them. A listing therefore costs about one call per MiB of the file instead of one per small read. A provider that skips the SDK and asks for anything else gets `unaligned`.
- **Budget.** A request may read at most `2 × size + 1 MiB` bytes in at most `2 × ceil(size / 1 MiB) + 64` calls. Past either the answer is `over-budget` and the request is cancelled.
- `sink.add(entry)` takes `{name, dir, size, encrypted, link}`; the SDK numbers entries in the order you add them and `read` names an entry by that number. It sends pages of at most 500 entries and 256 KiB, and returns `false` once Ostia wants no more (`limits.entries` is 20,000; names over 4 KiB, links over `limits.linkTargetBytes` and a listing over 8 MiB are refused). One malformed entry fails the whole listing.
- `sink.write(bytes)` sends an entry in chunks of at most 1 MiB, in memory only, and returns `false` once the entry is over `max`. Nothing you send is written to disk.
- `context` has `signal` (aborted when Ostia cancels), `limits` and, for `read`, `max`.
- **Errors.** Return `{ok: false, error}` or throw `new BrowseError(code)`. Listing: `unsupported`, `corrupt`, `limit`, `cancelled`, `failed`, `encrypted` (for example a 7z with encrypted headers). Reading: `gone`, `encrypted`, `link`, `too-large`, `limit`, `corrupt`, `cancelled`, `failed`. Ostia shows `limit` as a decompression limit and the others as unreadable.
- **Deadlines.** A listing has `limits.scanMs` (20 s) plus 5 s, an entry read 30 s. At the deadline Ostia cancels the request and ends the ticket; if it has not settled 5 s later, Ostia restarts your process. At most 4 requests per extension run at once, 16 wait, and the rest get `busy`. A late call with a dead ticket answers `unknown-ticket`.
- **What you must do yourself.** Ostia cannot see inside your decoder, so keep a decompression budget (`limits.scanBytes`, 1 GiB) and a nested-compression check, run CPU-heavy decoders in a worker, and never write to disk.

The `file-contents` capability is the human's to grant to a third-party extension. A provider is a Node process with network and disk access, so the approval card and this capability are the gate: they are not a sandbox. A sandboxed workspace's folder is not an exception: a third-party provider granted `file-contents` also gets bytes of archives inside it (a known gap).

## Lifecycle

- Started on first use of a contribution (command, panel), or with the window if it contributes
  sidebar items or asked to with `ext.startWithWindow(true)`. Stopped with SIGTERM when disabled, removed, or when Ostia quits; its token stops
  working at that moment, before the process exits. Re-enabled while still exiting, it starts
  again as soon as the old process is gone. A changed manifest stops the process too, and Ostia
  starts the new version again if the old one was running.
- If the process exits unexpectedly Ostia restarts it (0.5 s, 1 s, 2 s); after 3 restarts it is
  marked crashed until the user toggles it off and on. Your sidebar items, pane chips and
  subscriptions are cleared on exit; set them again after you reconnect.
- Exit when the socket closes (Ostia went away).
- stdout/stderr go to Ostia's log, prefixed `[ext:<id>]`.

## API version

The contract between Ostia and an extension (the manifest fields, the `ext.*` methods and events,
the SDK's types) has one version, `EXTENSION_API_VERSION` in `packages/extension-sdk/src/contract/extensionApi.ts`,
written `major.minor`:

- **minor** goes up when something is added and every existing extension keeps working;
- **major** goes up when something an extension may rely on is removed or changes meaning.
  Ostia provides exactly one major: an extension written for another major is not loaded.

Three places check it:

| Where | What happens |
|---|---|
| `ostia.json` `api` | Checked when the manifest is read (startup, hot reload, a marketplace catalog, `ostia-extension validate`). A newer minor or another major refuses the extension before anything runs |
| `OSTIA_EXTENSION_API` | Ostia puts the version it provides in the environment of every extension process, next to `OSTIA_SOCKET` and `OSTIA_TOKEN`, for extensions that speak the protocol without the SDK |
| SDK `connect()` | The SDK is built for one API version (`EXTENSION_API_VERSION`, also `ostiaExtensionApi` in its `package.json` and `api.json`). `connect()` throws when the app provides an older one, so an extension built with a newer SDK fails with a clear message instead of calling methods that aren't there |

Set `api` to the version of the SDK you build with. Raise it only when you start using something
newer; an extension that declares `1.0` keeps loading in every `1.x`.

For people changing Ostia: `packages/extension-sdk/api-lock.json` holds the version and a digest of the
published contract (the SDK's type declarations and the two manifest schemas). A change to any of
them fails `packages/extension-sdk/src/manifest/sdkPackage.integration.test.ts` until you run `pnpm api:bump minor` (or
`major`), which raises `EXTENSION_API_VERSION` and rewrites the lock in one step. There is no way
to refresh the digest without bumping.

## The SDK package

`@aurigax-ai/ostia-extension-sdk` on npm is the same SDK the built-in extensions use, packaged for
extensions written outside the app:

```sh
pnpm add -D @aurigax-ai/ostia-extension-sdk
```

| Part | What it is |
|---|---|
| `@aurigax-ai/ostia-extension-sdk` | `connect()` and everything in "Talking to Ostia" below the raw protocol |
| `…/panel`, `…/splitter`, `…/panel.css` | The panel page helpers and base styles |
| `…/atomicWrite` | `writeFileAtomic(path, text, {mode, dirMode})` and `writeFileAtomicAsync`: the folder is made with `dirMode` (an existing one is tightened to it), the text goes to a new temp file opened with `mode` and flushed, and one rename puts it in place. Use `{mode: 0o600, dirMode: 0o700}` for anything secret |
| `…/assist` | The assistant engine: `runAssistExtension({catalog})` with your own `ProviderCatalog` (needs `ai`, `zod`, `@ai-sdk-tool/parser`, `undici`) |
| `schemas/ostia.schema.json`, `schemas/ostia-marketplace.schema.json` | JSON Schemas for the two manifest files (also published under their old names, `ostia.schema.json` and `ostia-marketplace.schema.json`); name one in `"$schema"` and your editor checks the file as you type |
| `ostia-extension validate [folder]` | Runs the loader's own checks on an extension folder (its manifest, every catalog under `locales/`, plus the marketplace install limits), or on a marketplace folder and every extension it lists or holds unlisted. Exits 0 when Ostia would accept it |
| `ostia-extension unlist <extension folder> [marketplace folder]` | Moves a listed extension to `unlisted` in `ostia-marketplace.json` and generates its install code |
| `ostia-extension create <id> [folder]` | Writes a new extension project from `template/`: a `ostia.json` with that id, TypeScript source, a build that bundles it into one `main.js`, English and Traditional Chinese catalogs under `locales/`, `pnpm validate` |

It is generated from this repository by `pnpm build:sdk` (`packages/extension-sdk/scripts/build.mjs`) and published
to npm by `release.yml` on every `v*` tag; its version is the app's version. The JSON
Schemas come from `packages/extension-sdk/src/manifest/manifestSchema.ts`; the loader (`parseManifest`) stays the authority,
and `validate` runs that loader.

## Example: a minimal extension

`~/.config/ostia/extensions/hello/ostia.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "Greets, and shows the last exit code per workspace.",
  "capabilities": ["read-board", "notify"],
  "main": "main.js",
  "contributes": {
    "commands": [{ "id": "greet", "title": "Say Hello", "usage": "greet [name]" }],
    "sidebarItems": true
  }
}
```

`main.js` (install `vscode-jsonrpc` next to it, or bundle it):

```js
const { createConnection } = require('node:net')
const rpc = require('vscode-jsonrpc/node')

const socket = createConnection(process.env.OSTIA_SOCKET)
const conn = rpc.createMessageConnection(
  new rpc.StreamMessageReader(socket),
  new rpc.StreamMessageWriter(socket),
)

conn.onRequest('ext.command', async ({ command, args, caller }) => {
  if (command !== 'greet') return { ok: false, error: 'unknown-command' }
  const name = args?.argv?.[0] ?? 'there'
  await conn.sendRequest('ext.notify', { title: `Hello, ${name}` })
  return { ok: true, text: `hello ${name} from ${caller.kind}` }
})

conn.onNotification('ext.event', ({ type, payload }) => {
  if (type !== 'command.finished') return
  conn.sendRequest('ext.setSidebarItem', {
    workspaceId: payload.workspaceId,
    key: 'exit',
    text: `exit ${payload.exitCode ?? '?'}`,
    tone: payload.exitCode ? 'error' : 'ok',
  })
})

socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  await conn.sendRequest('ext.subscribe', { events: ['command.finished'] })
  await conn.sendRequest('ext.registerCommands', { commands: ['greet'] })
})
```

Restart Ostia, approve "Hello", then run `ostia hello greet you` in a pane or "Say Hello" from the
palette.

## Wrapping a CLI tool you already have

The `trellis` and `keeper` extensions (in the marketplace) are the reference for this. The pattern:

- Run the tool with `runTool(bin, args, {cwd, timeoutMs, env})` from the SDK: no shell, stdin
  closed, the extension's environment unless `env` replaces it, and `missing: true` when the
  binary isn't on `PATH`. At the timeout it answers at once with `timedOut: true` and stops the
  tool's whole process group (SIGTERM, then SIGKILL two seconds later). Parse its `--json`
  output in a pure module and unit-test that against captured real output.
- Missing tool or stopped daemon: set no sidebar items, return `{ok: false, error, message}`
  from commands with what to install or start, and have your panel handler return a static
  explanation page (`startMessageServer().url(title, body)`) instead of throwing. Retry with
  backoff (`nextBackoff`), never in a tight loop.
- If you start a long-running server, stop it in `onShutdown(fn)` (runs on exit, SIGTERM, SIGINT,
  SIGHUP). If you found it already running, leave it alone.
- Draw the tool's data yourself instead of embedding its web UI (trellis's `panel.ts`): serve
  your panel with `startPanelServer`, answer its `call()`s by running the tool, and call
  `changed()` when the tool reports a change (trellis follows `trellis events --consumer`). Write
  handlers that only the panel may use go in the `handle` you give `startPanelServer`, never in
  `registerCommands`, so no pane or agent can reach them.
- Pass free text to the tool so it cannot be read as a flag, a file or stdin (trellis reads
  `@path` and `-` in `--title` and `--body`, so the extension hands text over as private temp
  files), validate every id the panel sends, and build each call as an argv.
- If you read from a local daemon the tool already runs, keep its token in your process and never
  start or stop that daemon yourself.
- Build panel text from data with `h()` and text nodes, never `innerHTML`; render Markdown to a
  fixed set of elements and keep only http, https and mailto links (trellis's `markdown.ts`).
- Confirm with `ext.confirm` before changing the user's data. Never automate a decision the tool
  reserves for a human (keeper approvals).
- `call(method, params)` reaches any other control method your identity may use, for example
  `workspace.list` to put an item on every workspace whose workDir belongs to the tool.

## Declarative views: UI without a process

When all you need is something for the human to look at (a sidebar section of agents and their
state, a panel with a checklist, a few buttons that run palette commands), write a view instead
of an extension. A view is one JSON file, `~/.config/ostia/views/<name>.json` (`$XDG_CONFIG_HOME`
is honored; `<name>` is lowercase `a-z0-9-`, up to 40 characters). It has no process, no HTML and
no script: Ostia validates the file and draws it with its own components, bound to live data.

```json
{
  "version": 1,
  "title": "Agents",
  "placement": "sidebar",
  "icon": "robot",
  "root": {
    "type": "list", "for": "workspaces", "as": "ws", "empty": "No workspaces",
    "item": {
      "type": "row", "justify": "between",
      "children": [
        { "type": "text", "text": "{{ws.name}}", "truncate": true },
        { "type": "badge", "text": "{{ws.unread}}", "tone": "warn", "if": "{{ws.unread}}" },
        { "type": "button", "label": "Go", "variant": "ghost",
          "action": { "command": "workspace.goto", "args": { "index": "{{ws.index}}" } } }
      ]
    }
  }
}
```

- **Placement.** `sidebar`: a collapsible section in the workspace rail, under the workspaces.
  `panel`: a pane, opened from the palette ("Views: Open <title>") or with `ostia view open <name>`.
- **Components.** `stack`, `row`, `section`, `text`, `badge`, `icon` (a fixed list of Phosphor
  icons), `list` (`for` a data path, `as` an item name), `button`, `link`, `progress`, `kv`,
  `divider`. Every node may carry `if: "{{path}}"`. Unknown properties are errors.
- **Data** (read-only, live): `workspace` (the current one), `workspaces`, `panes` (of the current
  workspace, with their agent and attention), `ports` (the listening ports Ostia finds), `approvals`
  (`{pending}`), `notifications` (newest 50), `clock` (`{now}`, ticking each second). A
  workspace also carries `git`: the branch Ostia shows for it in the sidebar.
- **Bindings.** `{{path | filter}}` inside strings: dot-separated names or indices only, own
  properties only (`__proto__`, `constructor`, `prototype` are refused), missing paths render
  empty. Filters: `upper`, `lower`, `count`, `not`, `relative`, `time`, `date`.
- **Actions.** `{"command", "args"}` runs a palette command exactly like a user action in
  `settings.json`: strings in `args` take bindings (a whole-string binding keeps its type), and a
  command that needs a non-default capability asks the human first (Run once / Run and trust).
  `{"openUrl"}` and `link` open http/https URLs in the workspace's browser pane; any other scheme
  is refused when the file is read, and a binding that resolves to one draws a disabled control.
- **Budget.** 200 nodes, 10 levels and a 64 KiB file when read; while drawing, 50 items per list
  unless `limit` says fewer, and 1000 drawn nodes. Over budget, the last good render stays with a
  note saying why.
- **Approval.** A new file is pending: nothing is drawn until the human turns it on in
  Settings → Views, which lists every file with its placement, errors (line and path) and a
  reveal button. Agents can write files but can't enable them. Edits to an enabled view show
  live; an edit that breaks it keeps the last version that worked on screen.
- **Tools.** `ostia view schema` prints the JSON Schema, `ostia view validate <file>` prints one
  `file:line: path: message` per problem (both work outside Ostia), `ostia view list` shows
  each file's status.

## Built-in extensions

`src/extensions/<id>/` holds `ostia.json`, `main.ts` and optionally `panel.html`, `panel.ts`,
`panel.css`, `locales/` (every extension here ships `locales/zh-Hant.json`) and `*.thread.ts` entries, which the build bundles next to `main.js` for `worker_threads`.
`scripts/build-extensions.mjs` (part of `pnpm build`) bundles them into `out/extensions/<id>/`; electron-builder ships that dir as `resources/extensions`. They import
the SDK by its package name (`@aurigax-ai/ostia-extension-sdk` and its `contract/` modules) and
`src/shared/` — never `src/main` or `src/renderer`.

Git (the branch and diff stats chips, the Git panel, `ostia git …`) and Ports (the plug in the top
bar, the ssh login chip, `ostia ports list`) are part of Ostia itself, not extensions: they need no
process, read nothing until a window shows one of their items or a verb is used, and their settings
are Settings → Git and Settings → Ports.

| Id | What it does |
|---|---|
| `keymap-macos` | Two macOS keymaps as `contributes.keymaps` entries with no process (`platform: "darwin"`). `cmux` (`assets/cmux.json`) follows cmux's default shortcuts and drops Ostia's older second keys: ⇧⌘P palette (⌘K no longer opens it), ⌘P jump to a workspace (Go to File has no key under it), ⌘B sidebar, ⌘N new workspace, ⌘T new tab, ⌥⌘D the dashboard, and in a terminal ⌘D split right, ⇧⌘D split down, ⌥⌘ and an arrow to move between panes, ⇧⌘↩ zoom, and ⌘K or ⇧⌘K to clear. `iterm2` (`assets/iterm2.json`) follows iTerm2's default global keys: ⌘↑ ⌘↓ scroll one line, ⇧⌘↑ ⇧⌘↓ select the previous and next block, ⌘N new workspace, ⌘T new tab. Enabled like every built-in but not chosen: the `keymap` setting stays `null` until the human picks one in Settings → Keyboard |
| `langpack-zh-hant` | Traditional Chinese (`zh-Hant`) for the interface, as a `contributes.languages` pack with no process. Its `zh-Hant.json` is generated at build time from `zhHant` in `src/shared/app/dict.ts`, which stays typed against the English catalog so a missing string fails the typecheck |
| `system` | `ostia system info` (OS, kernel, arch, shell, package managers on PATH and the default one) and `ostia system install <pkg...> [--manager <name>] [--reason <text>] [--wait]`: validates the names, shows the human the exact install command and the reason, and on Approve runs it in a new terminal next to the agent (`ext.openTerminal`). Returns `{approved, command, paneId?}`; a denial exits 1. With `--wait` it returns when the install ends (`ext.openTerminal`'s `waitMs`, within the command's 10 minutes) and adds `{finished, exitCode}`; a failed install or a closed terminal exits 1 |
| `ssh` | The hosts of your ssh config and a session in a new terminal, with the system OpenSSH client. "SSH: Connect to Host…" and `ostia ssh connect [-J <hop>[,<hop>...]] [-p <port>] <[user@]host>` take ssh's own spelling and nothing else (any other option is refused), resolve the target with `ssh -G`, and open `ssh … -- <host>` beside the caller with `ext.openTerminal`; a pane caller is asked first, with the exact command, the resolved `user@host:port` and the bastion hops. `ostia ssh ls` lists the aliases (it reads `~/.ssh/config` and its `Include`s and runs nothing); `ostia ssh show <host>` resolves one. A caller in a sandboxed workspace is refused. Bastions come from `ProxyJump` in your config or from `-J`; the `user@host` chip is the Ports extension's. With the human's consent per host (a dialog naming the host and the exact path), it installs two readable shell files in `~/.ostia/helper/<version>/` there: `helper.sh`, which it talks to over `ssh -T`, and `session.sh`, the shell integration, so later sessions to that host type a short command that sources it (after a checksum check) instead of the whole integration: "SSH: Open Remote Folder", run from a session it opened, shows that session's current folder in Files through [Remote folders](#remote-folders). "SSH: Install Remote Helper on Host…" and "SSH: Remove Remote Helper…" are for the human only; `ostia ssh helpers` lists the answers. The helper connects without a terminal, so the host must accept a key or an ssh agent. Setting `remoteHelper` (on by default) turns all of it off |
| `serial` | A serial console in a new terminal, for a switch or router console port over a USB serial adapter, with no serial library, `screen` or `minicom`. "Serial: Connect to Device…" opens a terminal that lists the devices (`/dev/cu.*` on macOS, `/dev/ttyUSB*` and `/dev/ttyACM*` on Linux) and asks for the speed (115200 on Enter; 300 to 921600) and the frame (8N1 on Enter, or data bits 5–8, parity N/E/O and stop bits 1/2 such as `7E1`). `ostia serial connect <device> [<speed>] [<frame>] [--log <name>]` opens one directly, without a dialog, and answers `{device, speed, frame, paneId}` so an agent can go on with `ostia pane send` and `ostia pane read`; the device must be one of those serial paths, and `ostia serial ls` lists them as JSON. The terminal runs a small bridge with Ostia's own Electron binary as Node: it opens the device without blocking, sets the line with the system `stty` on that open descriptor (so macOS and Linux need no `-f`/`-F`), reopens it for blocking reads and forwards bytes both ways while the terminal is in raw mode. The pane is an ordinary terminal, so the human and agents (`ostia pane send` / `ostia pane read`) share one connection; Ctrl-] disconnects, and closing the terminal ends the bridge and releases the device. A session log is optional and always lives in `$OSTIA_EXTENSION_DATA/logs`: the picker asks for a file name (Enter for none) and `--log <name>` gives one, both only a name (letters, digits, `.`, `_`, `-`, no path or `..`), because an agent can type into the picker of a pane it opened. The folder is created 0700 and refused when it is a link, not a folder or not the user's; "Serial: Reveal Session Logs" opens it in Finder or the file manager when the human runs it from the palette; `ostia serial logs` from a pane only answers `{dir}` and opens no window. The log is opened only after the device opened, without following a symbolic link and only if it is a regular file with a single link (a hard link to another file is refused), appended to and set to mode 0600, one line per sent line (`>`) or received line (`<`), each with an ISO time stamp and control bytes escaped (`\r`, `\x1b`), plus `#` lines when the session opens and closes. `Ctrl-\` starts secret input for a password: the pane title gets a lock, what is typed until Enter (or `Ctrl-\` again) still goes to the device but stays out of the log, and the device's output from then until its echo of that Enter (or 1.5 s after it, plus the time the secret bytes take on the line at the chosen speed and frame) is hidden from the pane and the log, which records only that something was left out. When every byte sent (at least four, with an Enter among them) has come straight back unchanged and the device sent nothing of its own for 0.6 s, the pane says once that the cable may be in a network port or a loopback plug instead of the console port. A busy, missing or forbidden device, failed line settings and an unplugged adapter print a message in the terminal and end the bridge with a non-zero exit. A caller in a sandboxed workspace is refused |
| `archives` | Lists and opens what is inside zip, jar, tar, tar.gz, tar.zst, tar.xz, tar.bz2 and 7z files in the Files panel through the `browse` role of `contributes.fileKinds` (`archives.zip`, `archives.tar`, `archives.tar-xz`, `archives.tar-bz2`, `archives.sevenzip`), read-only and never extracting. It has `main` and the `file-contents` capability and no commands, so it starts on the first file you expand. zip uses yauzl over `BrowseFile.readAt`; tar uses the `tar` parser over `BrowseFile.stream()`, with gzip, zstd, xz and bzip2 told apart by their first bytes, a decoded-output budget and a refusal of compression inside compression (a `.tar.gz` that holds xz or bzip2 is refused as nested). xz goes through `XzGuard`, which checks every stream header, block header (one LZMA2 filter, dictionary at most 64 MiB, CRCs) and the index before the bytes reach the native decoder of `@napi-rs/lzma` (vendored with its platform binary through `vendor.json`; it is imported by this extension only). bzip2 is decoded by a pure-TypeScript decoder in a `worker_threads` thread (`bzip2.thread.ts`, 64 MB heap, terminated on cancel or timeout). 7z reads its signature header, plain or encoded header (one level) and streams info itself with every count and size checked against the bytes left in the header, and decodes a folder that is one chain of Copy, LZMA, LZMA2 and BCJ x86 coders (the raw LZMA and LZMA2 decoders of `@napi-rs/lzma`, dictionary at most 64 MiB). A listing needs only the header; reading an entry decodes its folder from the start, so the skipped prefix of a solid block counts against `limits.scanBytes` (`limit` past it) and the entry CRC is checked. BCJ2, PPMd, Deflate and the other filters make the archive `unsupported`, an encrypted header is `encrypted` for the list, and entries of an AES folder are marked encrypted. Symlinks (Unix mode in the attributes) are listed with their target read under the same budget (an empty target when it does not fit). Turning it off makes those files plain files again. See [Browsing inside a file](#browsing-inside-a-file) |
| `activity` | One panel for what each agent did. Its hooks (`UserPromptSubmit`, `PreToolUse`, `Stop`) record one line per event: the first line of the prompt, each tool call as a kind and a target (edited a file, ran a command, searched, read, started a subagent, opened a page), and the stop with the agent's closing message cut to four lines, which is the recap. Tool output is never taken and no transcript is read. Text goes through `ext.redact` first; when the scan fails the line is kept without text. Agents write and read it with `ostia activity`: `add "<text>" [--needs-you] [--link <path|url>]` stores a note from the calling pane (2000 characters, redacted first; a failed scan stores nothing and the command fails) and prints its id; `list [--needs-you] [--open] [--archived] [--since <time>] [--json]` and `show <id>` read the caller's workspace (another one with `--workspace <id>` needs `all-workspaces`, never from a sandboxed pane); `done <id>` closes the caller's own needs-you item. A needs-you item is something the human must see or do that does not block the agent; open ones are counted on the workspace's sidebar item, shown first in the panel with a Mark done button, and never age out. One journal per workspace under `$OSTIA_EXTENSION_DATA/journal/<workspaceId>.jsonl` (folder 0700, file 0600, never synced), capped at 512 KiB; entries older than `retentionDays` (14) or trimmed by the cap move to `$OSTIA_EXTENSION_DATA/archive/<workspaceId>/<YYYY-MM>.jsonl.gz` (gzip, 0600), kept for `archiveDays` (180) and at most 8 MiB per workspace. The same journal also holds the workspace's host events as a separate record kind, `host`, never hook input: pane started or closed (`pane.created`, `pane.closed`), agent status (`pane.attention`, state only), hibernated or woken (`pane.lifecycle`), folder changes (`cwd.changed`, relative to the workspace folder and through `ext.redact`) and, once the human grants `read-bus`, bus message metadata (`bus.message`: sender, receiver, kind, phase; never the text). They follow the same retention, archive and memory-only rules. A scratch workspace, a sandboxed one and one whose kind it cannot learn stay in memory, have no archive and are dropped when the workspace closes. The panel ("Activity: Open") shows only the workspace it is open in: its agents, most recent first, each with its state (from `pane.list`), its latest recap and the time since the last event; the recap is rendered as Markdown from a fixed set of elements (no raw HTML, no images, no remote loads; a link opens in the OS browser only when the human clicks it). The toggle Recap / Timeline is the setting `showActivity` (`ext.setSetting`) and shows each turn of the agent as a node on a timeline, newest first, with its prompt, its recap and its tool actions folded into one group that expands to the list. In Timeline the panel also lists the workspace's host events, newest first. A click on an agent shows its pane (`ext.focusPane`). It never types into a pane, answers an agent or sets attention, and it adds nothing to the agent's context |
| `skills` | Skill Workshop: short preference rules the human writes or approves, given to agents as session-start context and nothing else (a rule grants no permission). Its hooks are `SessionStart` (`on-session`: the active rules that apply to the folder, one line each, at most 40 rules and 6,000 characters, nothing for a manager, sandboxed, scratch or remote pane) and `UserPromptSubmit` (`on-prompt`: keeps the prompt only when `caller.humanPrompt` (the text main saw the human type) equals the hook's prompt, stores main's text, after `ext.redact`; a failed scan keeps nothing; 30 days, 2 MiB, `signals.jsonl` 0600). The Agent pane gets the same rules through a removable Rules chip. Rules, proposals, groups, test cases and runs live in `rules.json` and `evals.json` (0600, never synced). Extraction (`Find rules`) groups the human's own corrections (3 prompts, 2 sessions, 2 days) and asks the Agent model through `ext.agentComplete` to word one rule per group; it only proposes. Approve, retire, resolve, dismiss, test, and every other change are panel-only: no manifest command, socket method or CLI verb does any of them. The Scoreboard counts sessions a rule was given in, later prompts that say it again, and the 30 days before against since approval with 95% intervals; a test asks the model the same task a few times with and without the rule and checks each answer with a pattern the human wrote or accepted. Setting `holdout` (off) leaves a random tenth of rules out of a session to compare. |
| `agent` | The Agent pane's engine (the pi coding agent, exact version pinned and bundled): a session per pane in `$OSTIA_EXTENSION_DATA/sessions` (folder 0700, files 0600, never synced), models only from the key-less http(s) servers in the human-only `agent.providers` setting, pi's own tools switched off so that every tool is one of Ostia's and every call goes through `ext.agentTool`. No provider or cloud credential variable reaches it. |
| `graphs` | Runs a procedure written as a graph (`<workDir>/.ostia/graphs/<name>.yaml`) on the Wire interpreter (`@aurigax-ai/wire`, github.com/aurigax-ai/wire): agents in background terminals (start, continue a session the run started, message through the bus), approvals through `ext.ask`, commands through `ext.exec` without a terminal and inside the workspace's sandbox, waits, notifications that open the panel at the run, and connectors: MCP tools through `ext.mcpCall` (`use: mcp:<server>/<tool>`) and the `http` connector through a connection you make in its settings (`use: http.request`, `connection: <name>`; requests stay under the connection's base URL, with no user:password@ in it; refused in a sandboxed workspace). It starts from its triggers: `manual`, `schedule` (`every` or a five-field `cron`, `catchUp`), `files` (globs in the workspace folder, without `.git`, `node_modules` and ignored paths, at most 5000 folders), `command` (`exit`) and `agent` (`stopped` or `waiting`); a pane one of a graph's runs opened never fires that graph. A graph does nothing until the human clicks Enable on its exact definition in the Graphs panel; any change outside `ui` disables it. Each run is a journal under `$OSTIA_EXTENSION_DATA/runs/<workspaceId>/<graph>/<runId>/` (folder 0700, files 0600, never synced), read back after a restart: a waiting node is re-armed, a cut-off node runs again unless it is `once`, which waits for the human. `ostia graph validate`, `schema`, `nodes`, `explain`, `dry-run`, `list`, `runs`, `show`, `run` (only an enabled graph whose manual trigger says `agents: true`) and `report` (`contributes.verb: "graph"`). Pause, Resume, Cancel, Retry, Run it again, Continue session and Skip it are panel buttons only. Graphs run while Ostia is open. Settings: `maxSteps`, `maxRunsPerHour`, `maxParallel`, `maxAgentsPerRun`, `maxRunHours` |
| `assistant` | The assist points on the providers the human adds in Settings → Assistant: `ollama`, any `openai-compatible` endpoint (LM Studio, llama.cpp server, …), `openrouter`, `openai` or `anthropic`, several at once, each with its own base URL, API key and models. Built on the AI SDK (`ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`, zod for structured answers). Every request names its provider and model; the engine checks per model whether tools are native or described in the prompt. A switch per feature (`typos`, `promptReview`, `commandSuggest`, `terminalCompletions`, `editorCompletions`, `chat`, `explainError`) and a requests-per-minute limit are its own settings. Inert until a provider with a model exists. It has no panel: Settings → Assistant shows the models in use, each feature with its switch, model, readiness, shortcut and "Try it", and the providers; "Assistant: Chat" opens the chat pane |

### Marketplace extensions

These live in the same source tree, but they wrap tools only some people have, so they are not
shipped in the app. They import the SDK only by its package name
(`@aurigax-ai/ostia-extension-sdk`), never by a path into this tree, because they are published as
a project of their own: `pnpm build:marketplace` (`scripts/build-marketplace.mjs`) assembles
`out/marketplace/` from `marketplace/` (build script, `tsconfig.json`, CI,
`ostia-marketplace.json`), the extensions listed there (shown or unlisted), their tests and
`test/fixtures/tools`, writes its `package.json`, and builds it against `out/sdk`. One function
builds an extension folder for both the app and that project (`buildExtension` in
`marketplace/build-extension.mjs`, which `scripts/build-extensions.mjs` imports):
`ostia.json`, `locales/`, a bundled `main.js`, a panel's `panel.html`, `panel.css`, bundled
`panel.js` and the SDK's `panel.css` as `base.css`, and the npm packages an extension's
`vendor.json` names, copied unchanged (`packages` copies one package to a folder, `closures`
copies a package and everything it depends on into a `node_modules` folder). An optional `bundle.json` next to `ostia.json` holds an `alias` map (`{ "alias": { "stream": "stream-browserify" } }`) applied to the extension's browser bundles, for a bundled library that imports a Node built-in. The project's
`package.json` lists every vendored package at the exact version the app pins, so its own
`pnpm install` and `pnpm build` produce the same `extensions/`. `pnpm publish:marketplace <checkout>`
copies that into a checkout of the marketplace repository (`aurigax-ai/ostia-extensions`), installs
its dependencies there (the SDK from npm) and rebuilds `extensions/`. That repository's own
`sync.yml` workflow does this every hour: when Ostia's latest release is newer than its `package.json` version it checks that tag out, runs the command,
its checks, and commits. It needs no credentials from this repository. Add that repository in
Settings → Extensions → Marketplaces to install them.

| Id | What it does |
|---|---|
| `lsp-rust-analyzer`, `lsp-clangd`, `lsp-lua`, `lsp-marksman` | One native language server each, with the `download` form: `rust-analyzer` 2026-09-28 (Linux, macOS and Windows on x64 and arm64), `clangd` 23.1.0 (Linux x64, macOS, Windows x64; other platforms use `PATH`), `lua-language-server` 3.19.1 (Linux and macOS on x64 and arm64, Windows x64) and `marksman` 2026-02-08 for Markdown (Linux x64 and arm64, macOS, Windows x64). Each pins the official GitHub release asset and its SHA-256 |
| `lsp-gopls` | `gopls` for Go with the `goInstall` form: `go install golang.org/x/tools/gopls@v0.23.0` when no `gopls` is on `PATH`. Needs Go; without it the extension’s row in Settings › Extensions offers to install Go |
| `lsp-typescript` | TypeScript and JavaScript in the editor: `typescript-language-server` 5.3.0 and TypeScript 5.9.3, copied unchanged from their npm packages into `server/` (the extension's `vendor.json` `packages`) and run with Ostia's Electron as Node. A project's own TypeScript is used when it has one. Two settings, off by default, show reference and implementation counts as code lenses. The app itself ships no TypeScript language features: without this extension a `.ts` or `.js` file is only highlighted |
| `lsp-pyright` | Python in the editor: Pyright 1.1.414, copied the same way (about 5,400 files, mostly type stubs). Setting `typeCheckingMode` |
| `lsp-yaml` | YAML in the editor: `yaml-language-server` 1.24.0 with its 19 dependencies, copied unchanged into `server/node_modules/` (`vendor.json` `closures`). Setting `schemaStore` (off by default) lets the server fetch schemas from schemastore.org |
| `lsp-bash` | Shell scripts in the editor: `bash-language-server` 5.8.1 with its 35 dependencies, copied the same way. It lints with `shellcheck` when that is on `PATH` |
| `trellis` | A board, card and vault panel drawn from the `trellis` CLI's JSON for the workspace's project (or any project you pick): columns and cards with labels, priority and claims, a card pane with its Markdown body, relations, comments and activity (read from a Trellis daemon that is already running; never started), move, comment, claim, renew, release and a new-card form, "Work on this" on a card (send it to an agent already running in the workspace through `ext.offerToAgent`, or start one of the human's agents on it with `ext.runAgent`, from the panel only; the prompt is built from the card's ref, title and body and asks the agent to claim it, comment progress and move it to review), the agent working on a card shown on it (click shows its pane) and as a `task` chip on the agent's pane, a read-only vault browser, all updated live from `trellis events --consumer`. The open card count of the active workspace as a `cards` workspace chip in the top bar (click opens the board), notifications when an agent moves a card to review or blocked that open the card, "Trellis: Open Board", "Trellis: Open Card" (`ostia trellis card <REF>`), "Trellis: Open Vault", "Trellis: Init Project Here", `ostia trellis status`. Agents get no verb that changes a card. Settings: `notifyReview`, `notifyBlocked`, `refreshSeconds` |
| `keeper` | The Keeper dashboard as a panel, a footer count of queries waiting for approval, "Keeper needs approval" notifications that open the approvals queue (Keeper has no per-ticket page), "Keeper: Open Dashboard", "Keeper: Show Pending Approvals" (`ostia keeper approvals`). It only reads the queue. Settings: `notify`, `pollSeconds`, `idlePollSeconds` |
| `model-runtime` | The user's local model-runtime (`$XDG_RUNTIME_DIR/model-runtime.sock` unless `baseUrl` says otherwise) as one more provider: every model it lists as installed joins the model lists in Settings → Assistant and the chat's model selector, with load and unload in Settings → Assistant. It runs the same engine as `assistant` (`packages/extension-sdk/src/assist/`, `runAssistExtension`) with its own one-provider catalog; tools are described in the prompt. The human chooses in Settings → Assistant which features use one of its models |
| `screens` | Alpha, unlisted (installed only with its install code). A client of the `screens` service (`@aurigax-ai/screens`): `ostia screen create`, `token`, `list`, `stop` for the caller's own workspace (a screen is labelled with its workspace id; `token` answers only a pane in that workspace), an `ext.confirm` card before an agent's first screen in a workspace with "Always for this workspace" (revoked in the panel; an unanswered card is a refusal), the screen verbs (`screenshot`, `click`, `move`, `drag`, `scroll`, `type`, `key`, `launch`, `windows`) relayed for a sandboxed workspace with only the flags each takes, new sandboxed screens allowed only the workspace's domains (`ext.sandboxDomains`), and a loopback panel under a per-panel token path that lists the workspace's screens, creates and stops them and offers to install the service (`pnpm add -g @aurigax-ai/screens@latest` in a terminal after `ext.confirm`; it needs screens 0.1.1 or later, offers Update for an older one and creates nothing on it) and its system programs (through `ostia system install`). Every screen it created stops when its workspace closes (`workspace.closed`) or the extension ends |

Earlier versions also shipped `kanban` and `wiki` extensions. They were removed: boards, cards and
knowledge entries live in Trellis (the `trellis` extension and the `trellis` CLI). Ostia does not
read their old `board.json` and `wiki.json` files; entries for them in `extensions.json` are
ignored.
