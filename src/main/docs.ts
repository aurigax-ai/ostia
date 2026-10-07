import type { ExtensionInfo } from '../shared/extensions'
import { registerControlMethod } from './controlServer'

const CLI_HELP = `ostia — control-socket CLI

  ostia whoami                   show this pane's identity
  ostia commands                 list commands available in this window
  ostia open <file>...           show files to the human in the editor (text, image or PDF),
                                 any path on disk; file:line[:col] jumps there. Several files
                                 get a tab each.
                                 A sandboxed workspace opens only files under the home folder
  ostia <file>...                same, when the first word is a path (has a /, or starts with
                                 . or ~) or names a file here that is no command or extension
  ostia pane.list                 every pane, every workspace — {paneId(external),workspaceId,
                                  kind,title,cwd,running,blockCount,lastExitCode,agent,
                                  agentSessionId,agentState,agentMessage,splitTabId,
                                  splitTabName}; a restored pane keeps its paneId across
                                  restarts. splitTabId is set for a pane inside a split tab (one
                                  tab showing several panes side by side)
  ostia workspace.list              every workspace — {workspaceId,name,kind,workDir,state,groupId}
  ostia notify <title> [body]    desktop notification + marks this pane unread in Ostia
  ostia ask "<question>" [--context <text|->] [--choice <label>]… [--multi] [--timeout <seconds>] [--json]
                                 ask the human a question and wait for the answer. It shows on
                                 Ostia's dashboard with this workspace's name and folder, marks
                                 this pane waiting and notifies the human when they are away.
                                 No --choice: free text. With --choice (up to 12): pick one, or
                                 several with --multi; the human can always add a reply.
                                 --context recaps what the work is (- reads stdin).
                                 Prints the chosen labels one per line, then the reply; --json
                                 prints {answered,choices,text}. Exit 0 answered, 2 dismissed,
                                 3 timed out, 4 pane closed. It waits as long as it runs: if the
                                 command is stopped, the question is withdrawn. At most 3 open
                                 questions per pane
  ostia state <waiting|done|working|error|clear> [message] [--pane <externalId>]
                                 set this pane's attention state (message '-' reads stdin;
                                 a JSON object on stdin contributes its "message" field,
                                 or names its "tool_name" for a permission request);
                                 --pane targets another pane (needs all-workspaces)
  ostia workspace dir [path]     make this folder (default: your current one) the workspace's folder:
                                 its name, where new tabs start, and what its vault and chat tools
                                 are scoped to. Refused for a sandboxed or scratch workspace
  ostia workspace describe <text|-> | --clear
                                 show a short summary (Markdown links allowed) under this
                                 pane's workspace in the sidebar, e.g. the PR you're on
  ostia workspace list [--json]  every workspace with its sidebar group; --json prints
                                 {workspaces,groups} (groups: {groupId,name,color,collapsed,
                                 workspaceIds})
  ostia workspace group <name>   move this pane's workspace into the sidebar group <name>
                                 (created if missing)
  ostia workspace ungroup        take this pane's workspace out of its group
  ostia workspace rename [--workspace <id>] <name…> | --clear  rename your workspace in the
                                 sidebar (--clear goes back to its default name); another
                                 workspace asks the human (send-other-pane, all-workspaces)
  ostia workspace import-cmux [file] [--json]
                                 recreate cmux's saved workspaces (names, folders, splits,
                                 tabs; default file ~/Library/Application Support/cmux/
                                 session-com.cmuxterm.app.json). Workspaces already here are
                                 skipped; it prints what could not be carried over
  ostia resume-token <claude|codex> <id|->
                                 remember this pane's agent session so a restored pane
                                 offers Resume (Ctrl+Shift+R); '-' reads a hook's JSON
                                 (session_id) from stdin
  ostia claude-hook <Notification|PreToolUse|Stop|StopFailure>
                                 set this pane's attention from a Claude Code hook's JSON on
                                 stdin: a permission prompt, a question or a plan to review
                                 is waiting; the idle reminder and a finished subagent are not
  ostia workflow list [--json]   saved command workflows this pane can use: this workspace's
                                 .ostia/workflows, the user's workflows
                                 folder and extensions;
                                 --json prints {workflows,problems}
  ostia workflow show <name> [--json]
                                 one workflow's command, arguments and defaults (read-only;
                                 fill the {{placeholders}} and run the command yourself)
  ostia view schema              JSON Schema of a view file (~/.config/ostia/views/<name>.json)
  ostia view validate <file>     check a view file: file:line: path: message, exit 1 on problems
  ostia view list [--json]       view files and their status (pending until the human enables)
  ostia view open <name>         open an enabled panel view as a pane in this workspace
  ostia process run "<cmd>" [--name X] [--cwd P]  run a command in a new terminal tab beside
                                 you, where the human can watch and type; your shell line is
                                 pasted as written and run by the tab's own shell (zsh or bash).
                                 Prints {id,name,paneId}; your pane keeps the focus.
                                 --split-tab T: the first run with T opens its tab as usual;
                                 each later run with the same T joins that tab, splitting it
                                 --split right (default) or down, so one tab shows them side
                                 by side (a split tab named T). It never types into a pane
                                 that is already open
  ostia agent run <agent> [--name X] [--cwd P] [--split-tab T [--split right|down]] <prompt|->
                                 start another agent (claude, codex or
                                 one the human configured) in a new terminal tab with that prompt
                                 as its one argument, quoted for you (- reads it from stdin).
                                 Same result and rules as process run: follow it with ostia process
                                 logs, talk to it with ostia pane send and ostia pane read
  ostia process ls               id, name, status, paneId, command of this workspace's
                                 processes: starting, running, exited(code), or closed (the
                                 human closed the tab)
  ostia process logs <id|name> [--since N]  that command's output only, as plain text; prints
                                 (cursor=N) on stderr, pass it to --since to read on. For a
                                 full-screen program use ostia pane read
  ostia process kill <id|name>   interrupt it (Ctrl+C); if it keeps running, end the tab's
                                 shell. The tab stays open with its output
  ostia process restart <id|name> interrupt it and run the same line again in the same tab
  ostia pane send <pane> [--enter] [--paste|--raw] [--force] [--confirm] [--] <text…|->
                                 type text into another terminal pane; no Enter unless
                                 --enter. <pane> is a paneId from ostia pane.list, or a
                                 process id or name. '-' reads the text from stdin.
                                 Multi-line text goes in as one bracketed paste when the
                                 program turned that mode on (Claude Code, Codex, shells),
                                 then Enter; --paste forces a paste, --raw types it as is.
                                 Text to an agent that is waiting for the human (permission
                                 prompt, question) is refused with the reason; answer with
                                 ostia pane key, or add --force. --confirm waits up to 2s
                                 for the pane to print something and exits 2 if it did not
  ostia pane key <pane> <key>…   press keys there: enter tab shift-tab escape backspace delete
                                 space up down left right home end pageup pagedown ctrl-a..ctrl-z
  ostia pane read <pane> [--lines N] [--json]  that pane's screen as plain text (default 200
                                 lines, max 2000); --json adds cwd, running, lastExitCode.
                                 A tab you opened with ostia process run needs nothing more;
                                 any other pane asks the human (type-other-pane,
                                 read-other-pane, plus all-workspaces outside your workspace)
  ostia pane rename <pane> <title…>  name that pane's tab; programs (OSC titles) no longer
                                 change it, and it survives a restart. --clear instead of a
                                 title hands the tab back to the program. Your own pane
                                 ($OSTIA_PANE_ID) needs nothing; another pane asks the human
                                 (send-other-pane, plus all-workspaces outside your workspace)
  ostia token create <name> --cap <capability>…  make a token for scripts outside Ostia
                                 (launchd jobs, cron, a dispatcher). It can hold only
                                 read-board, read-other-pane, type-other-pane and
                                 all-workspaces, asks the human first (settings-write plus
                                 those capabilities) and is printed once. A script sets
                                 OSTIA_TOKEN to it; with OSTIA_SOCKET unset, ostia finds the
                                 socket in control.json in the app data folder. Scripts reach
                                 only pane.list, workspace.list, workspace.groups, pane.read
                                 and pane.input, never ask the human, and get
                                 needs-elevation for a capability the token lacks
  ostia token list [--json]      the tokens (never their values)
  ostia token revoke <id>        delete a token; scripts using it are cut off at once
  ostia vault set <KEY> [--global]  store a secret (value read from stdin, no echo)
  ostia vault get <KEY> [--global]  print a stored secret
  ostia vault ls [--global]        list stored secret keys (never values)
  ostia vault rm <KEY> [--global]  delete a stored secret
  ostia sandbox request-domain <host>  ask the human to let this sandbox reach a host
  ostia sandbox expose <port>          ask the human to reach a sandboxed server from this computer
  ostia secret ls                      list secrets you may ask for (names and labels, never values)
  ostia secret get <name> [--reason t]  ask the human for a secret's value (prints it on approval)
  ostia bus send <toExternalId> "<msg>"       send a message to another pane's inbox; answers
                                              delivered: waiting (the receiver is in bus wait)
                                              or queued (it reads it at its next prompt)
  ostia bus inbox [--drain]                   print your inbox, marking it seen (optionally clearing it)
  ostia bus sent [--json]                     your own recent messages, each seen or unseen
  ostia bus wait [--timeout MS]               block until an unseen message arrives (default 30s)
  ostia bus handoff <to> --task "..." --summary "..."  hand a task off to another pane
  ostia bus claim <id>                        claim a handoff addressed to you
  ostia bus handoffs [--all]                  list your handoffs (--all needs all-workspaces)
  ostia bus done <id>                         mark a handoff completed
  ostia settings get [key]        print every readable setting, or a dot-path value
  ostia settings set <key> <value> [--dry-run]  validate and set a dot-path (JSON if it parses)
  ostia settings unset <key>      reset a dot-path to its default
  ostia settings schema [key]     the JSON Schema of every setting, or of one key
  ostia browse <command> [--pane ID] [--json]    drive the workspace's browser pane (elevated
                                  'browse'); agent-browser's command contract. --json prints
                                  {success,data,error}
  ostia browse open [url] | back | forward | reload | close | read | pushstate <url>
  ostia browse snapshot [-i] [-c] [-d N] [-s SEL] [-u]  aria tree with [ref=eN] refs
  ostia browse click <sel> [--new-tab] | dblclick | hover | focus | check | uncheck <sel>
  ostia browse fill <sel> <text> | type <sel> <text> | select <sel> <value...>
  ostia browse press <key> | keydown <key> | keyup <key>  (Enter, Control+a, …)
  ostia browse keyboard type|inserttext <text>
  ostia browse scroll [up|down|left|right] [px] [--selector SEL] | scrollintoview <sel>
  ostia browse drag <from> <to> | upload <sel> <file...>
  ostia browse mouse move <x> <y> | down|up [button] | wheel <dy> [dx]
  ostia browse get text|html|value|attr|title|url|count|box|styles [sel] [arg]
  ostia browse is visible|enabled|checked <sel>
  ostia browse find role|text|label|placeholder|alt|title|testid <value> [action] [text]
                  [--name N] [--exact]; find first|last <sel> [action]; find nth <i> <sel> [action]
  ostia browse wait <sel|ms> [--state S] | --text T | --url GLOB | --load L | --fn JS
                  | --download [path]  [--timeout MS]
  ostia browse eval <js> | -b <base64> | --stdin
  ostia browse screenshot [path] [--full] | pdf <path>
  ostia browse cookies [get] | set <name> <value> [--url --domain --path --httpOnly --secure
                  --sameSite --expires] | clear
  ostia browse storage local|session [key] | set <key> <value> | clear
  ostia browse state save|load <path>
  ostia browse network requests [--filter --type --method --status --clear] | request <id>
                  | route <glob> [--abort] [--body JSON] | unroute [glob]
  ostia browse set viewport <w> <h> [scale] | media [dark|light] [reduced-motion]
                  | offline [on|off] | headers <json> | geo <lat> <lng>
  ostia browse tab | tab new [url] | tab <tabId> | tab close [tabId]
                  (a tab on the human's own browser profile asks them on every command)
  ostia browse frame <sel|main> | dialog accept [text]|dismiss|status
  ostia browse console [--clear] | errors [--clear] | highlight <sel> | inspect
  ostia browse addinitscript <js> | removeinitscript <id> | addstyle <css>
  ostia browse batch [--bail] "<command>"... (or a JSON array of argv arrays on stdin)
  ostia browse identify | zoom in|out|reset | history clear | focus-mode enter|exit|toggle
                  | react-grab toggle|get | focus-webview | is-webview-focused
  ostia browse pick [--timeout MS]  ask the user to click an element; prints its capture JSON
  ostia gateway pair                         mint a pairing code + QR payload (not-running unless the human turned remote access on)
  ostia gateway status                       { running, host, port, fingerprint, deviceCount, tailnet, route }
  ostia gateway devices                      list paired phones (never prints tokens; caps are granted only in Settings → Remote)
  ostia gateway revoke <deviceId>             revoke a paired phone immediately
  ostia ext ls                   list enabled extensions and their commands
  ostia ext <extId> <command> [args...]  run an extension command
  ostia <extId> <command> [args...]      same, when <extId> isn't a built-in verb
  ostia docs                     show this help

  A browse <sel> is an @eN ref from snapshot, a CSS selector, text=Label or xpath=//…
  (refs are valid until the next navigation).

  ostia <command-id> [jsonArgs]  run any registered command by id, with an
                                  optional JSON-encoded args blob
`

export const MANAGER_HELP = `

  Manager only (you are the manager):
  ostia manager read <paneId> [--lines N]    a pane's screen as plain text (default 200 lines)
  ostia manager spawn <preset> [--cwd DIR] [--workspace ID] [--name NAME] [-- args…]
                                  start a worker agent in a new terminal pane; prints its paneId
  ostia manager input <paneId> [--text TEXT] [--key KEY]…
                                  type into another pane (only with manager.allowInput on);
                                  keys: enter tab shift-tab escape backspace delete space up down
                                  left right home end pageup pagedown ctrl-a..ctrl-z
`

export function extensionHelp(
  extensions: Pick<ExtensionInfo, 'id' | 'name' | 'commands'>[],
): string {
  const lines: string[] = []
  for (const ext of extensions) {
    if (ext.commands.length === 0) continue
    lines.push('', `  ${ext.name} (extension '${ext.id}'):`)
    for (const cmd of ext.commands) {
      const usage = `ostia ${ext.id} ${cmd.usage ?? cmd.id}`
      lines.push(`  ${usage.padEnd(52)} ${cmd.title}`)
    }
  }
  return lines.join('\n')
}

export function registerDocsMethods(deps: {
  extensions: () => Pick<ExtensionInfo, 'id' | 'name' | 'commands'>[]
}): void {
  registerControlMethod('docs', {
    handler: (_params, ctx) => ({
      cli: `${CLI_HELP}${extensionHelp(deps.extensions())}${ctx.identity.manager ? MANAGER_HELP : ''}`,
      note: 'run `ostia commands --json` for the machine-readable command list',
    }),
  })
}
