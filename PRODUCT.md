# Product

## Register

product

## Users

Power developers who live in the terminal and increasingly run **several AI coding
agents at once** (Claude, Codex, and other CLIs) alongside their own shell work. Their
context is a focused, high-stakes work session — often multiple projects, branches, and
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
than owning it. Agents are first-class sessions, not a side panel. Success looks like a
developer running many terminals and agents at once and always feeling the room — aware of
every session's state without staring at any single pane — while the interface itself
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
- **State is never hue-alone.** Agent/session state always pairs color with an icon,
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
| 1 | Best-in-class integration with agent CLIs (Claude Code, Codex, …) via tools and plugins | partial | `pine` CLI + control socket + the `pine` agent skill (`.claude/skills/pine/`): open files, notify, `pine state` (waiting/done/working/error), processes, wiki, kanban, bus, vault, browser automation. Agents surface their waiting/done state through `pine state` hooks (`docs/AGENT-HOOKS.md`: Claude Code `Notification`/`Stop`/`UserPromptSubmit`, Codex `notify`) or OSC 9/99/777. Next: agent resume on restore, and the extension API. |
| 2 | A real plugin system | partial | Built-in plugin registry (`renderer/plugins/`) for themes and locales. Next: a plugin manifest + loader for third-party commands and panels. |
| 3 | Open files, view diffs, and a browser the agent can see | partial | Monaco editor, in-app browser with full agent automation (`pine browse …`: read, click, eval, screenshot, console, errors). Next: git diff view (Monaco's built-in diff editor) and "pick element → send to agent" (selector + screenshot + console errors posted to the agent's pane). For the user's real Chrome, pair the agent with Chrome DevTools MCP rather than re-implementing CDP here. |
| 4 | Integrate the user's own tools (Trellis, Keeper) | not started | Lands on top of goal 2: each becomes a plugin (panel + commands) that shells out to its CLI. |
| 5 | Sessions survive app restart, crash, and reboot, with their logs | built | Layout autosaved continuously; each pane's scrollback autosaved every 5 s and at quit; everything restores idle at its cwd. A live process can't survive (needs a pty-host daemon, see CLAUDE.md §8). |
| 6 | Simple code editing | built | Monaco with LSP for quick edits. Decision: stay a *quick-edit* surface, never chase IDE parity; add an "Open in VS Code / Zed at file:line" handoff for deep work. |
| 7 | Support everyday dev tasks with agents | partial | Background processes, kanban, wiki, message bus between agent panes. Warp-style blocks: click a block's gutter (or Ctrl+Shift+↑/↓, ⌘↑/⌘↓) to select it; copy its command/output or rerun it at an idle prompt; a sticky header names the command whose output you're reading; command history search across every pane (Ctrl+Shift+H / ⌘⇧H) inserts a past command into the prompt. Next: saved workflows. |
| 8 | Settings sync | not started | Settings are one JSON file (`settings.json`); sync will be file-based (git or a synced folder) before anything hosted. |
| 9 | Multitasking with many agents: system + in-app notifications | built | Per-pane attention (waiting/done/error + unread) from OSC 9/99/777, BEL, failed or long commands, `pine state` and `pine notify`; attention rings on panes, unread badges and aggregated state on sidebar rows, jump to latest unread (Ctrl+Shift+U / ⌘⇧U), a notification center (bell) backed by the persisted log in main, desktop notifications that jump to their pane. |
| 10 | A companion app that connects to this machine (LAN or remote) to watch and drive any session or agent | built | Gateway (`src/main/gateway/`): self-signed TLS `https`+`ws`, device pairing, live pane streams, session/pane lists, notifications — LAN or Tailscale, off by default, no hosted relay. Contract: `pine-companion/NETWORK-CONTRACT.md`. Client: the Expo app in `~/Personal/pine-companion`. Settings → Remote picks the bind address (loopback, LAN, or a detected Tailscale address) and grants each paired phone `command`, `input`, `board.write` or `destructive` (confirmed) per device; phones then type into panes, resize them, run palette commands, and get `agent.needs-input`/`agent.done`/`notify` pushes. "See the desktop" means pane/browser streams first, whole-screen capture only if needed. |
