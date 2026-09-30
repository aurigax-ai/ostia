# Product

## Register

product

## Users

Power developers who live in the terminal and increasingly run **several AI coding
agents at once** (Claude, Codex, and other CLIs) alongside their own shell work. Their
context is a focused, high-stakes work workspace — often multiple projects, branches, and
long-running agent tasks in flight simultaneously. They are fluent in tools like Warp,
Zed, VSCode, Linear, and Raycast, so they expect keyboard-first speed, density, and
standard affordances that behave exactly as they assume.

**The job to be done:** direct and supervise concurrent terminal + agent work without
losing situational awareness — know at a glance what's running, what's waiting on you,
and what just finished, then jump straight to the one that needs attention.

## Product Purpose

Pine is a cross-platform, terminal-first workspace — a Warp-like terminal with command
*blocks*, a VSCode-like file tree + Monaco editor with LSP, live git, managed agent CLIs,
and a control plane (CLI + local socket, plus an optional LAN gateway for a phone
companion) for driving it.

It exists to be **mission control for agents**: the terminal stays the center of gravity,
and the file tree, editor, and inspector *orbit* the terminal's working directory rather
than owning it. Agents are first-class workspaces, not a side panel. Success looks like a
developer running many terminals and agents at once and always feeling the room — aware of
every workspace's state without staring at any single pane — while the interface itself
stays quiet and out of the way.

## Brand Personality

**Calm · precise · alive.** A calm, disciplined instrument panel: quiet dark chrome,
exact spacing, no decorative noise. The *life* of the interface comes entirely from live
agent state — working, waiting, done — surfaced ambiently so the workspace feels busy
without shouting. Voice is that of an expert peer: direct, terse, confident; recommends
and keeps momentum rather than presenting long menus of options. A genuine native desktop
app, not a website in a window.

## Anti-references

- **Website-in-Electron.** No web-app-in-a-window feel, no generic website component-kit
  look. Pine must read as a real native desktop application.
- **Generic neon dev-tool.** Not the pure near-black + acid-green terminal cliché; not
  matrix/hacker cosplay. Energy is signal-driven, not neon.
- **Cluttered IDE overload.** No VSCode-style wall of toolbars, activity bars, panels, and
  status noise all competing for attention. Chrome stays minimal; density serves the task.
- **Flashy consumer SaaS.** No decorative gradients, glassmorphism-as-default, hero-metric
  marketing gloss, or animation for its own sake. Every effect must earn its place.

## Design Principles

1. **Situational awareness is the product.** The interface's core job is to keep the user
   aware of what every terminal and agent is doing — without them staring at any one pane.
   Spend the design budget on making live state legible and glanceable.
2. **The tool disappears into the task.** Earned familiarity over spectacle: standard
   affordances for standard jobs, one consistent component vocabulary across every screen.
   If a control looks different in two places, one is wrong.
3. **Quiet by default, loud exactly where it matters.** The chrome stays still and
   disciplined; boldness is reserved for the one signature (live agent status). Restraint
   everywhere makes the one loud thing readable.
4. **The terminal is the center; everything orbits it.** CLI-first — the GUI augments the
   terminal and the terminal drives the GUI (deep shell↔app integration via OSC). Files,
   editor, and inspector follow the terminal's cwd; they never own it.
5. **Native, not nested.** Design for a desktop application: keyboard-first navigation,
   real density, OS-appropriate window conventions — never a browser page ported into a
   frame.

## Accessibility & Inclusion

- **Target WCAG AA.** Body text ≥ 4.5:1 contrast; UI and large text ≥ 3:1. No light-gray
  "elegance" that sacrifices legibility on the dark chrome.
- **Keyboard-first.** Every action reachable without a mouse; visible `:focus-visible`
  rings; inline shortcut hints; a ⌘K command palette as the discovery surface.
- **State is never hue-alone.** Agent/workspace state always pairs color with an icon,
  label, or shape (ring, badge, dot) so it survives color-blindness and grayscale.
- **Reduced motion honored.** Ambient/state animations respect
  `prefers-reduced-motion` — pulses degrade to static indicators, never removed silently.
- **Internationalized from day one.** English (default) + Traditional Chinese (`zh-Hant`),
  variant-aware resolution, no hardcoded strings, and first-class CJK rendering (dual-width
  mono for correct terminal column alignment, `<html lang>` tracking for shaping + a11y).

## Goals

The outline the product is built against, in priority order. Status reflects the code, not
intentions: **built**, **partial**, or **not started**. The plan for closing the gaps is `docs/ROADMAP.md`.

| # | Goal | Status | What exists / next step |
|---|---|---|---|
| 1 | Best-in-class integration with agent CLIs (Claude Code, Codex, …) via tools and plugins | partial | `pine` CLI + control socket + the `pine` agent skill (`.claude/skills/pine/`): open files, notify, `pine state` (waiting/done/working/error), processes, bus, vault, browser automation; agents (or you) add buttons and tab-menu entries as data (`actions` in `settings.json`, each a palette command + args; ones that need extra permission ask before their first run), and `pine settings set` validates changes (`--dry-run`, `unset`, `schema`); a pane running an agent shows a robot icon in its header with the session title, id, state, run time and folder; when an agent needs a permission it lacks, the call waits while its pane shows an approval card (Allow once / for this pane / Deny, also in the notification center's inbox with recent decisions and Revoke), or Settings → Agents lets requests through and only records them (destructive actions always ask); boards, cards and knowledge entries go through the `trellis` CLI (goal 4). Agents surface their waiting/done state through `pine state` hooks (`docs/AGENT-HOOKS.md`: Claude Code `Notification`/`Stop`/`UserPromptSubmit`, Codex `notify`) or OSC 9/99/777. Agent resume: a `SessionStart` hook (Claude Code) or `notify` (Codex) records the agent's session id on its pane with `pine resume-token`; after a restart the pane offers "Resume claude" (Ctrl+Shift+R / ⌘⇧R). New agent-facing features ship as extension commands. |
| 2 | A real plugin system | built | Extensions (`docs/EXTENSIONS.md`): a `pine.json` manifest plus an optional process in any language, discovered from the app and `~/.config/pine/extensions` (reloaded live when that folder changes; new extensions and new capabilities still wait for the user's approval), approved by the user on first run and toggled in Settings → Plugins. They contribute palette + CLI commands (`pine <extId> <command>`; a command can ask the palette for one typed argument), subscribe to pane/command/cwd/focus/notification events, list workspaces and panes, put status items in the sidebar and chips on a pane's header (clickable to run one of their commands or open a link in the browser pane), declare typed settings the user edits in Settings → Plugins, post notifications, open a sandboxed panel pane (optionally at a path, navigating an open panel in place, also from a notification click), open a diff pane, ask the human to confirm (commands that wait on the human are marked `interactive`), open a new terminal that runs an argv at its first prompt, and, when approved for `all-workspaces`, drive a named pane's browser, background processes and attention. Git, Trellis, Keeper and System (`pine system info`, and `pine system install`, which runs a package install only after the human approves the exact command, in a new terminal next to the agent) ship as built-in extensions on this API (pine's own kanban and wiki were removed in favour of Trellis). Themes, locales and LSP specs remain data-only built-in contributions (`renderer/plugins/`). The built-ins use pane chips, settings and panel paths (Git's branch and diff stats chips with graph and blame pages, ports and ssh chips, Trellis card links, Keeper's approvals page). |
| 3 | Open files, view diffs, and a browser the agent can see | built | Monaco editor with "Open in External Editor"; the built-in Git extension (sidebar branch + `+new ~changed` per workspace; branch `main • ↑2 ↓1` and diff stats `3 • +12 -4` chips on every terminal in a repo, also in the Pine prompt; a panel to stage, unstage, discard (after a confirm) and commit, with changed files as a flat list or a folder tree; a commit graph (colored lanes for branches and merges, branch/tag/remote/HEAD badges, an "Uncommitted changes" row with staged and unstaged counts, ahead/behind of the upstream) of the current branch by default, all branches, or branches you pick, whose commits open their files as diffs; graph scope and list/tree view are also in Settings → Plugins → Git, and "Git: Blame File" for the open file; `pine git status/changes/diff/open/log/blame/stage/unstage/commit` for agents) opening files in a read-only Monaco diff pane any extension can use (`ext.openDiff`); in-app browser with full agent automation: `pine browse …` follows vercel-labs/agent-browser's command contract (accessibility `snapshot` with `@eN` refs, click/fill/type/press/find/wait/get/eval, cookies, storage, network requests and routes, tabs, `--json`, `batch`) on Pine's own browser panes. A storage drawer in each browser pane shows its cookies (domain, path, expiry, HttpOnly, Secure, SameSite), local storage and session storage, with a filter, copy, edit, delete and a confirmed clear-all. Pick element: "Point at element" captures the clicked element (selector, html, style, box, role/name, console errors, failed requests, screenshot) and sends it with a note to an agent's pane as a markdown report pasted as `@<path>`; agents ask the human to point with `pine browse pick`. Send selection: text selected in the editor or Markdown preview, a dragged region of an image (image viewer with fit/zoom), or selected text or a page region of a PDF (pdf.js viewer with page navigation and zoom) goes to an agent the same way, as `selection-N.md` (+ PNG). So does a terminal selection or a command block's output. Right-click a file-tree row or an editor tab to copy its path (or relative path) or paste `@<path>` at an agent's prompt; the tree highlights the open file. For the user's real Chrome, agents pair with Chrome DevTools MCP (`docs/CHROME.md`). |
| 4 | Integrate the user's own tools (Trellis, Keeper) | built | Two built-in extensions that shell out to the tools' CLIs. Trellis is pine's board and knowledge store: there is no separate pine kanban or wiki. **Trellis**: the web UI as a panel, opened on the workspace's project (`.trellis` marker) through a loopback proxy that holds the Trellis token; per-workspace sidebar counts of open and claimed cards; a named `trellis events` consumer that notifies when an agent moves a card into a review or blocked column, and clicking the notice opens that card (or navigates the open Trellis panel to it); "Trellis: Open Board", "Trellis: Open Card" (asks for the card id; `pine trellis card <REF>`) and "Trellis: Init Project Here" (confirmed first); settings for which columns notify and the sidebar refresh interval. **Keeper**: the dashboard as a panel, a sidebar count of queries waiting for approval (read-only `keeper approve --json`; pine never approves), and a "Keeper needs approval" notification that opens the panel on its approvals queue (Keeper's dashboard has no per-ticket page, so the ticket is found there by its agent and intent); settings for the poll intervals and whether to notify. Both hide their items and explain themselves when the tool is missing or its daemon is down. |
| 5 | Workspaces survive app restart, crash, and reboot, with their logs | built | Layout (splits and per-pane tabs) autosaved continuously; each pane's scrollback autosaved every 5 s and at quit; everything restores idle at its cwd. Nothing is created on its own: a first launch (or closing the last workspace) shows an empty work zone with "New workspace" (Ctrl+Shift+T / ⌘T). A live process can't survive (needs a pty-host daemon, see CLAUDE.md §8). |
| 6 | Simple code editing | built | Monaco with LSP for quick edits, a live Markdown preview toggle for `.md` files (react-markdown + GFM, styled with shadcn Typeset), plus "Open in External Editor" (palette, editor context menu, diff toolbar) that hands the file at the cursor's line to VS Code / Cursor / Zed (auto-detected) or any command in `behavior.externalEditor`. Decision: stay a *quick-edit* surface, never chase IDE parity. |
| 7 | Support everyday dev tasks with agents | built | Background processes, message bus between agent panes, Trellis boards and knowledge entries (goal 4). Warp-style blocks: click a block's gutter (or Ctrl+Shift+↑/↓, ⌘↑/⌘↓) to select it; copy its command/output or rerun it at an idle prompt; a sticky header names the command whose output you're reading; command history search across every pane (Ctrl+Shift+H / ⌘⇧H) inserts a past command into the prompt. The sidebar shows each workspace's listening ports (click to open in the browser pane) and the host of a running ssh, and each terminal's header shows a ports chip (click opens its first port in the browser pane) and a Warp-style remote login chip (`user@host` of a running ssh), all from the built-in `ports` extension (scan interval and the host used for port links in its settings). Optional agent hibernation (Settings → Agents): idle, hidden agents that stored a resume token have their shell stopped once too many run, keeping the scrollback, and Resume brings them back. Optional Warp-style input editor (Settings → Terminal → Input mode): at an idle prompt it takes over the shell's input line in place (one prompt, never a second box), with multi-line drafts, highlighting, history suggestions, prefix history on Up, completion on Tab (paths, command names, and subcommands, options and values with descriptions for about 700 tools from Fig's open-source specs, or your own in `~/.config/pine/completions`), readline keys and an optional vim mode; keys it doesn't own (Ctrl+R, fzf's Ctrl+T/Alt+C, Escape) hand the draft to the shell's own line; running programs keep direct keyboard input. Optional Pine prompt (Settings → Terminal → Prompt, or right-click the prompt → Edit prompt): Warp-style context chips (conda, virtualenv, node version, cwd, user, host, Kubernetes context, date, time, last exit code and duration) in the input editor, arranged in a drag-and-drop editor with a live preview, and a plain "cwd" shell prompt in new shells so scrollback stays readable; chips an extension contributes (`contributes.paneChips`) are listed in the editor and shown in the row in the chosen order; Git's branch and diff stats chips follow the directory by default, as in Warp. Warp-style saved workflows: YAML commands with `{{argument}}` placeholders from your config folder, the project's `.pine/workflows` and extensions, found with Workflows: Search (Ctrl+Shift+S / ⌘⇧S), filled in through an argument form and inserted at an idle prompt (never run); save any block or history command as one, and agents read them with `pine workflow list|show`. |
| 8 | Settings sync | built | Settings → Sync points `sync.dir` at a folder you own (a repository you commit, Syncthing, Dropbox). `settings.json` and extension enablement/approvals (`extensions.json`) are mirrored there and picked up on startup, window focus and local edits; when both sides changed since the last sync, the newer file wins and the other is kept as a conflict copy in the folder. Secrets (vault, gateway device tokens, certificates), capability grants and `sync.dir` itself never sync. Nothing hosted is planned. |
| 9 | Multitasking with many agents: system + in-app notifications | built | Per-pane attention (waiting/done/error + unread) from OSC 9/99/777, BEL, failed or long commands, `pine state` and `pine notify`; attention rings on panes, unread badges and aggregated state on sidebar rows, cmux-style workspace rows (rename, agent-set description via `pine workspace describe`, pin, reorder by menu or drag, mark read, close others, Ctrl/⌘+1..9 to jump; Settings → Workspaces picks where new ones appear, whether they start in the current folder, a default folder, confirmation before closing or quitting with a running command, and title wrapping), cmux-style workspace groups (colored, collapsible headers that keep the members' attention dot and unread count, drag into/out of/between groups, new workspaces join the active one's group, `workspaceGroups.byCwd` auto-grouping, `pine workspace group|ungroup|list`), jump to latest unread (Ctrl+Shift+U / ⌘⇧U), a notification center (bell) backed by the persisted log in main, desktop notifications that jump to their pane. |
| 10 | A companion app that connects to this machine (LAN or remote) to watch and drive any workspace or agent | built | Gateway (`src/main/gateway/`): self-signed TLS `https`+`ws`, device pairing, live pane streams, workspace/pane lists, notifications — LAN or Tailscale, off by default, no hosted relay. Contract: `pine-companion/NETWORK-CONTRACT.md`. Client: the Expo app in `~/Personal/pine-companion`. Settings → Remote picks the bind address (loopback, LAN, or a detected Tailscale address) and grants each paired phone `command`, `input` or `destructive` (confirmed) per device; phones then type into panes, resize them, run palette commands, and get `agent.needs-input`/`agent.done`/`notify` pushes. "See the desktop" means pane/browser streams first, whole-screen capture only if needed. |
