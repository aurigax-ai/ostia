# Agents and your real Chrome

Pine's in-app browser is a Chromium `<webview>` that agents drive through `pine browse …`. Pine
does not re-implement the Chrome DevTools Protocol for your own Chrome. When an agent needs your
real browser (your profile, your extensions, your logged-in tabs), pair it with **Chrome DevTools
MCP**, the MCP server maintained by the Chrome DevTools team.

- Package: [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp)
- Source and docs: <https://github.com/ChromeDevTools/chrome-devtools-mcp>

Checked against the upstream docs on 2026-09-28. Flags move; if a command below fails, check
`docs/configuration.md` in that repo.

## Which browser to use

| Situation | Use |
|---|---|
| You want to show the agent where a UI problem is | Pine's browser: **Point at element** in the browser pane's toolbar, write what's wrong, send it to the agent's pane |
| The agent wants you to point at something | Pine's browser: the agent runs `pine browse pick` and waits for your click |
| A local dev server (`localhost`), a quick check, a screenshot, console errors | Pine's browser (`pine browse open/read/click/screenshot/errors`) |
| The page needs your real login, SSO, cookies, or extensions | Your Chrome + Chrome DevTools MCP |
| Performance traces, Lighthouse-style audits, network throttling, CPU emulation | Your Chrome + Chrome DevTools MCP (it exposes DevTools' performance tooling) |
| You want nothing from your real profile touched | Pine's browser (each pane has its own throwaway in-memory partition) |

Pine's browser panes never share cookies with each other or with your Chrome. That isolation is
the point of using them for agent work, and the reason to reach for real Chrome when a task needs
your identity.

## Setup

Claude Code:

```sh
claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest
```

Or as a plugin that also installs the upstream skills:

```text
/plugin marketplace add ChromeDevTools/chrome-devtools-mcp
/plugin install chrome-devtools-mcp@chrome-devtools-plugins
```

Codex:

```sh
codex mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
```

Any other MCP client takes the standard block:

```json
{
  "mcpServers": {
    "chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }
  }
}
```

`pnpm dlx chrome-devtools-mcp@latest` works in place of `npx chrome-devtools-mcp@latest` if you
prefer pnpm.

With no extra flags the server starts its own Chrome with a dedicated profile the first time the
agent uses a browser tool. `--isolated` makes that profile temporary.

## Attaching to the Chrome you already have open

Two options, both from the upstream docs:

1. **Auto-connect (Chrome 144+).** In your Chrome, open `chrome://inspect/#remote-debugging` and
   start the remote debugging server. Then add `--autoConnect` to the server's arguments, for
   example `claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest --autoConnect`.
   Use `--channel` (`canary`, `dev`, `beta`, `stable`) if the Chrome you use isn't stable.
2. **A debugging port.** Start Chrome with a port and a non-default profile directory (Chrome
   refuses remote debugging on the default profile):

   ```sh
   google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile-stable
   ```

   and pass `--browser-url=http://127.0.0.1:9222` to the server.

A remote debugging port lets any local program control that browser. Don't browse sensitive
sites in it while the port is open, and close it when the agent is done.

## Running it from a Pine pane

The MCP server is started by the agent CLI (Claude Code, Codex) running in your terminal pane;
Pine isn't involved. Pine's own tools still work alongside it: the agent can use Chrome DevTools
MCP for your real Chrome and `pine browse …` for Pine's browser in the same session.
