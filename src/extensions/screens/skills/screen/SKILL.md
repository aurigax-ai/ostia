---
name: screen
description: Gives the agent its own screen, a desktop separate from the human's display. Use when a task needs a graphical desktop - opening a web page in a real browser, clicking through a GUI app, or taking screenshots of what a program draws.
---

# Your own screen

A screen is a desktop of its own: programs you start there never appear on the human's display,
and nothing you do there reaches the human's keyboard, mouse, clipboard or files. The human can
watch it in the Screens panel and take it over; while they hold it, your input is refused with
`human-owns-input` until they give it back.

## Get a screen

```sh
ostia screen create            # one per task is usually enough; the first one may wait for the human's OK
ostia screen list              # this workspace's screens: id, size, owner, state
ostia screen token             # the agent token of this workspace's screen (add the id when there are several)
```

`create` may wait while the human decides. If it answers `refused`, do not retry; tell the human you
needed a screen and why. Screens stop when the workspace closes; stop yours when you are done:

```sh
ostia screen stop
```

## Use it

Outside a sandbox, use the screens tools with the token in `SCREENS_TOKEN`, never on a command line
that others can read:

```sh
export SCREENS_TOKEN="$(ostia screen token)"
screens mcp --screen <id>       # an MCP server with the computer tool, for clients that take one
screens screenshot <id> --out <file.png>
screens launch <id> -- firefox https://example.com
```

In a sandboxed workspace there is no screens socket. Use the same verbs through Ostia instead:

```sh
ostia screen screenshot         # JSON with width, height and a base64 PNG
ostia screen launch -- firefox https://example.com
ostia screen click 640 400
ostia screen type "hello"
ostia screen key ctrl+l
ostia screen scroll down 3
ostia screen move 100 200
ostia screen drag 10 10 300 300
ostia screen windows
```

Add `--screen <id>` when the workspace has more than one screen. A sandboxed screen reaches only
the domains the workspace allows; a page on another host waits until the human allows it.

Flags: `create [--width N] [--height N] [--allow DOMAIN]…` (sizes 64 to 8192; a sandboxed
workspace takes no `--allow`), `screenshot [--max-side N]`,
`click [--button B] [--count N] [--modifiers KEYS] [--down|--up]`, `drag` and `scroll` with
`[--modifiers KEYS]`, and `key <keys…> [--repeat N]`. `ostia screen open` opens the Screens panel
for the human.

## A phone screen

When the human starts a session on their phone and picks this workspace, the phone's screen shows
up in `ostia screen list` like any screen, for as long as the session runs (5 to 30 minutes, set
on the phone). It ends when the human stops it, when the time runs out, or when they leave. Use it
with the same verbs:

```sh
ostia screen screenshot         # what the phone shows now
ostia screen tree               # its controls: text, bounds, which ones click, edit or scroll
ostia screen apps               # the apps you may open
ostia screen launch -- com.android.settings
ostia screen click 540 1200     # a tap; --count 2 for a double tap, --down then --up for a long press
ostia screen scroll down 3
ostia screen type "hello"
ostia screen key Escape         # Escape is back, Home is home, alt+Tab is recents, Return, BackSpace, Tab
```

To ask for one, say why in one line; the phone shows it and its human decides:

```sh
ostia screen ask-phone --reason "check the login screen of the app build"
```

It waits up to 2 minutes and answers when the human started a session, or fails with `declined`
(the human said no, or phone control is off there) or `no-answer`.

Coordinates are the phone's pixels. `move`, `cursor`, `windows`, `focus`, `hold-key` and right or
middle clicks answer `unsupported`. When the human touches the phone your input is refused with
`human-owns-input` until they resume it on the phone. Banking, password and system screens are
blocked: you see black, and input answers `blocked-app`.

## Rules

- Take a screenshot before you click, and after, to see what changed.
- Keep the token to yourself: do not print it in a message, a file or a commit.
- Never try to reach the human's own display or windows.
