import type { ExtensionInfo } from '../shared/extensions'
import { registerControlMethod } from './controlServer'

const CLI_HELP = `pine — control-socket CLI

  pine whoami                    show this pane's identity
  pine commands                  list commands available in this window
  pine open <file>...            show files to the human in the editor (text, image or PDF),
                                 any path on disk; file:line[:col] jumps there. Several files
                                 get a tab each.
                                 A sandboxed workspace opens only files under the home folder
  pine <file>...                 same, when the first word is a path (has a /, or starts with
                                 . or ~) or names a file here that is no command or extension
  pine pane.list                  every pane, every workspace — {paneId(external),workspaceId,
                                  kind,title,cwd,running,blockCount,lastExitCode}
  pine workspace.list               every workspace — {workspaceId,name,kind,workDir,state,groupId}
  pine notify <title> [body]     desktop notification + marks this pane unread in Pine
  pine ask "<question>" [--context <text|->] [--choice <label>]… [--multi] [--timeout <seconds>] [--json]
                                 ask the human a question and wait for the answer. It shows on
                                 Pine's dashboard with this workspace's name and folder, marks
                                 this pane waiting and notifies the human when they are away.
                                 No --choice: free text. With --choice (up to 12): pick one, or
                                 several with --multi; the human can always add a reply.
                                 --context recaps what the work is (- reads stdin).
                                 Prints the chosen labels one per line, then the reply; --json
                                 prints {answered,choices,text}. Exit 0 answered, 2 dismissed,
                                 3 timed out, 4 pane closed. It waits as long as it runs: if the
                                 command is stopped, the question is withdrawn. At most 3 open
                                 questions per pane
  pine state <waiting|done|working|error|clear> [message] [--pane <externalId>]
                                 set this pane's attention state (message '-' reads stdin;
                                 a JSON object on stdin contributes its "message" field,
                                 or names its "tool_name" for a permission request);
                                 --pane targets another pane (needs all-workspaces)
  pine workspace dir [path]      make this folder (default: your current one) the workspace's folder:
                                 its name, where new tabs start, and what its vault and chat tools
                                 are scoped to. Refused for a sandboxed or scratch workspace
  pine workspace describe <text|-> | --clear
                                 show a short summary (Markdown links allowed) under this
                                 pane's workspace in the sidebar, e.g. the PR you're on
  pine workspace list [--json]   every workspace with its sidebar group; --json prints
                                 {workspaces,groups} (groups: {groupId,name,color,collapsed,
                                 workspaceIds})
  pine workspace group <name>    move this pane's workspace into the sidebar group <name>
                                 (created if missing)
  pine workspace ungroup         take this pane's workspace out of its group
  pine resume-token <claude|codex> <id|->
                                 remember this pane's agent session so a restored pane
                                 offers Resume (Ctrl+Shift+R); '-' reads a hook's JSON
                                 (session_id) from stdin
  pine workflow list [--json]    saved command workflows this pane can use: this workspace's
                                 .pine/workflows, the user's workflows folder and extensions;
                                 --json prints {workflows,problems}
  pine workflow show <name> [--json]
                                 one workflow's command, arguments and defaults (read-only;
                                 fill the {{placeholders}} and run the command yourself)
  pine view schema               JSON Schema of a view file (~/.config/pine/views/<name>.json)
  pine view validate <file>      check a view file: file:line: path: message, exit 1 on problems
  pine view list [--json]        view files and their status (pending until the human enables)
  pine view open <name>          open an enabled panel view as a pane in this workspace
  pine process run "<cmd>" [--name X] [--cwd P]   run a command in a new terminal tab beside
                                 you, where the human can watch and type; your shell line is
                                 pasted as written and run by the tab's own shell (zsh or bash).
                                 Prints {id,name,paneId}; your pane keeps the focus
  pine agent run <agent> [--name X] [--cwd P] <prompt|->   start another agent (claude, codex or
                                 one the human configured) in a new terminal tab with that prompt
                                 as its one argument, quoted for you (- reads it from stdin).
                                 Same result and rules as process run: follow it with pine process
                                 logs, talk to it with pine pane send and pine pane read
  pine process ls                id, name, status, paneId, command of this workspace's
                                 processes: starting, running, exited(code), or closed (the
                                 human closed the tab)
  pine process logs <id|name> [--since N]   that command's output only, as plain text; prints
                                 (cursor=N) on stderr, pass it to --since to read on. For a
                                 full-screen program use pine pane read
  pine process kill <id|name>    interrupt it (Ctrl+C); if it keeps running, end the tab's
                                 shell. The tab stays open with its output
  pine process restart <id|name> interrupt it and run the same line again in the same tab
  pine pane send <pane> [--enter] [--] <text…>   type text into another terminal pane; no Enter
                                 unless --enter. <pane> is a paneId from pine pane.list, or a
                                 process id or name
  pine pane key <pane> <key>…    press keys there: enter tab shift-tab escape backspace delete
                                 space up down left right home end pageup pagedown ctrl-a..ctrl-z
  pine pane read <pane> [--lines N] [--json]   that pane's screen as plain text (default 200
                                 lines, max 2000); --json adds cwd, running, lastExitCode.
                                 A tab you opened with pine process run needs nothing more;
                                 any other pane asks the human (type-other-pane,
                                 read-other-pane, plus all-workspaces outside your workspace)
  pine vault set <KEY> [--global]  store a secret (value read from stdin, no echo)
  pine vault get <KEY> [--global]  print a stored secret
  pine vault ls [--global]         list stored secret keys (never values)
  pine vault rm <KEY> [--global]   delete a stored secret
  pine sandbox request-domain <host>   ask the human to let this sandbox reach a host
  pine sandbox expose <port>           ask the human to reach a sandboxed server from this computer
  pine secret ls                       list secrets you may ask for (names and labels, never values)
  pine secret get <name> [--reason t]  ask the human for a secret's value (prints it on approval)
  pine bus send <toExternalId> "<msg>"        send a message to another pane's inbox
  pine bus inbox [--drain]                    print your inbox (optionally clearing it)
  pine bus wait [--timeout MS]                block until a message arrives (default 30s)
  pine bus handoff <to> --task "..." --summary "..."   hand a task off to another pane
  pine bus claim <id>                         claim a handoff addressed to you
  pine bus handoffs [--all]                   list your handoffs (--all needs all-workspaces)
  pine bus done <id>                          mark a handoff completed
  pine settings get [key]         print every readable setting, or a dot-path value
  pine settings set <key> <value> [--dry-run]   validate and set a dot-path (JSON if it parses)
  pine settings unset <key>       reset a dot-path to its default
  pine settings schema [key]      the JSON Schema of every setting, or of one key
  pine browse <command> [--pane ID] [--json]     drive the workspace's browser pane (elevated
                                  'browse'); agent-browser's command contract. --json prints
                                  {success,data,error}
  pine browse open [url] | back | forward | reload | close | read | pushstate <url>
  pine browse snapshot [-i] [-c] [-d N] [-s SEL] [-u]   aria tree with [ref=eN] refs
  pine browse click <sel> [--new-tab] | dblclick | hover | focus | check | uncheck <sel>
  pine browse fill <sel> <text> | type <sel> <text> | select <sel> <value...>
  pine browse press <key> | keydown <key> | keyup <key>   (Enter, Control+a, …)
  pine browse keyboard type|inserttext <text>
  pine browse scroll [up|down|left|right] [px] [--selector SEL] | scrollintoview <sel>
  pine browse drag <from> <to> | upload <sel> <file...>
  pine browse mouse move <x> <y> | down|up [button] | wheel <dy> [dx]
  pine browse get text|html|value|attr|title|url|count|box|styles [sel] [arg]
  pine browse is visible|enabled|checked <sel>
  pine browse find role|text|label|placeholder|alt|title|testid <value> [action] [text]
                  [--name N] [--exact]; find first|last <sel> [action]; find nth <i> <sel> [action]
  pine browse wait <sel|ms> [--state S] | --text T | --url GLOB | --load L | --fn JS
                  | --download [path]  [--timeout MS]
  pine browse eval <js> | -b <base64> | --stdin
  pine browse screenshot [path] [--full] | pdf <path>
  pine browse cookies [get] | set <name> <value> [--url --domain --path --httpOnly --secure
                  --sameSite --expires] | clear
  pine browse storage local|session [key] | set <key> <value> | clear
  pine browse state save|load <path>
  pine browse network requests [--filter --type --method --status --clear] | request <id>
                  | route <glob> [--abort] [--body JSON] | unroute [glob]
  pine browse set viewport <w> <h> [scale] | media [dark|light] [reduced-motion]
                  | offline [on|off] | headers <json> | geo <lat> <lng>
  pine browse tab | tab new [url] | tab <tabId> | tab close [tabId]
                  (a tab on the human's own browser profile asks them on every command)
  pine browse frame <sel|main> | dialog accept [text]|dismiss|status
  pine browse console [--clear] | errors [--clear] | highlight <sel> | inspect
  pine browse addinitscript <js> | removeinitscript <id> | addstyle <css>
  pine browse batch [--bail] "<command>"... (or a JSON array of argv arrays on stdin)
  pine browse identify | zoom in|out|reset | history clear | focus-mode enter|exit|toggle
                  | react-grab toggle|get | focus-webview | is-webview-focused
  pine browse pick [--timeout MS]  ask the user to click an element; prints its capture JSON
  pine gateway enable [--host H] [--port P]  turn on the LAN control gateway (elevated 'gateway')
  pine gateway pair                          mint a pairing code + QR payload (enables gateway too)
  pine gateway status                        { running, host, port, fingerprint, deviceCount }
  pine gateway devices                       list paired phones (never prints tokens; caps are granted only in Settings → Remote)
  pine gateway revoke <deviceId>              revoke a paired phone immediately
  pine gateway disable                       turn off the LAN control gateway
  pine ext ls                    list enabled extensions and their commands
  pine ext <extId> <command> [args...]   run an extension command
  pine <extId> <command> [args...]       same, when <extId> isn't a built-in verb
  pine docs                      show this help

  A browse <sel> is an @eN ref from snapshot, a CSS selector, text=Label or xpath=//…
  (refs are valid until the next navigation).

  pine <command-id> [jsonArgs]   run any registered command by id, with an
                                  optional JSON-encoded args blob
`

export const MANAGER_HELP = `

  Manager only (you are the manager):
  pine manager read <paneId> [--lines N]     a pane's screen as plain text (default 200 lines)
  pine manager spawn <preset> [--cwd DIR] [--workspace ID] [--name NAME] [-- args…]
                                  start a worker agent in a new terminal pane; prints its paneId
  pine manager input <paneId> [--text TEXT] [--key KEY]…
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
      const usage = `pine ${ext.id} ${cmd.usage ?? cmd.id}`
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
      note: 'run `pine commands --json` for the machine-readable command list',
    }),
  })
}
