import type { ExtensionInfo } from '../shared/extensions'
import { registerControlMethod } from './controlServer'

const CLI_HELP = `pine — control-socket CLI

  pine whoami                    show this pane's identity
  pine commands                  list commands available in this window
  pine open <file>               open <file> in the editor
  pine pane.list                  every pane, every workspace — {paneId(external),workspaceId,
                                  kind,title,cwd,running,blockCount,lastExitCode}
  pine workspace.list               every workspace — {workspaceId,name,kind,workDir,state}
  pine notify <title> [body]     desktop notification + marks this pane unread in Pine
  pine state <waiting|done|working|error|clear> [message] [--pane <externalId>]
                                 set this pane's attention state (message '-' reads stdin;
                                 a JSON object on stdin contributes its "message" field);
                                 --pane targets another pane (needs all-workspaces)
  pine resume-token <claude|codex> <id|->
                                 remember this pane's agent session so a restored pane
                                 offers Resume (Ctrl+Shift+R); '-' reads a hook's JSON
                                 (session_id / thread-id) from stdin
  pine process run "<cmd>" [--name X] [--cwd P]   start a tracked background process
  pine process ls                                 list tracked processes
  pine process logs <id|name> [--since N]         print captured output
  pine process kill <id|name>                     kill a tracked process
  pine process restart <id|name>                   kill (if running) and re-run
  pine vault set <KEY> [--global]  store a secret (value read from stdin, no echo)
  pine vault get <KEY> [--global]  print a stored secret
  pine vault ls [--global]         list stored secret keys (never values)
  pine vault rm <KEY> [--global]   delete a stored secret
  pine bus send <toExternalId> "<msg>"        send a message to another pane's inbox
  pine bus inbox [--drain]                    print your inbox (optionally clearing it)
  pine bus wait [--timeout MS]                block until a message arrives (default 30s)
  pine bus handoff <to> --task "..." --summary "..."   hand a task off to another pane
  pine bus claim <id>                         claim a handoff addressed to you
  pine bus handoffs [--all]                   list your handoffs (--all needs all-workspaces)
  pine bus done <id>                          mark a handoff completed
  pine settings get [key]         print the whole settings state, or a dot-path value
  pine settings set <key> <value> deep-set a dot-path (value parsed as JSON if it parses)
  pine browse open <url> [--pane ID]                agent-drive the browser pane (elevated 'browse')
  pine browse nav <back|forward|reload> [--pane ID]  navigate the browser pane
  pine browse read [selector] [--pane ID]            print visible text (page, or a selector's)
  pine browse click <selector> [--pane ID]           click the first matching element
  pine browse type <selector> <text> [--pane ID]     set an input's value + fire input/change
  pine browse dblclick <selector> [--pane ID]        dispatch a double-click
  pine browse hover <selector> [--pane ID]           dispatch mouseover/mouseenter/mousemove
  pine browse focus <selector> [--pane ID]           focus an element
  pine browse check <selector> [--pane ID]           set a checkbox/radio checked + fire input/change
  pine browse uncheck <selector> [--pane ID]         clear a checkbox + fire input/change
  pine browse scroll-into-view <selector> [--pane ID]  scroll an element into view (centered)
  pine browse fill <selector> <text> [--pane ID]     whole-value set + fire input/change
  pine browse select <selector> <value> [--pane ID]  set a <select>'s value + fire change
  pine browse scroll [--x N] [--y N] [--selector S] [--pane ID]  scroll the page or an element
  pine browse press <key> [--selector S] [--pane ID]  real keyDown+keyUp (focuses selector first)
  pine browse keydown <key> [--selector S] [--pane ID]  real keyDown only
  pine browse keyup <key> [--selector S] [--pane ID]  real keyUp only
  pine browse eval "<js>" [--pane ID]                run JS in the page, print the JSON result
  pine browse wait <selector> [--timeout MS] [--pane ID]  poll until a selector appears
  pine browse screenshot [path] [--pane ID]          capture the page to a PNG, print its path
  pine browse content [--pane ID]                    print the page's outerHTML (capped ~1MB)
  pine browse snapshot [selector] [--interactive] [--pane ID]  a11y-ish text tree with [eN] refs
  pine browse get <sub> [selector] [--attr X] [--property P] [--pane ID]
                                  url|title|text|html|value|attr|count|box|styles
  pine browse is <sub> <selector> [--pane ID]        visible|enabled|checked
  pine browse find <by> <query> [--exact] [--index N] [--selector S] [--pane ID]
                                  role|text|label|placeholder|alt|title|testid|first|last|nth
                                  -> prints an @eN ref
  pine browse highlight <selector> [--ms N] [--pane ID]  briefly outline an element
  pine browse url [--pane ID]                        print the current page URL
  pine browse zoom <in|out|reset> [--pane ID]        adjust zoom level by 0.5, print new level
  pine browse devtools [toggle|open|close|console] [--pane ID]  default: toggle
  pine browse focus-webview [--pane ID]              focus the guest webContents
  pine browse is-webview-focused [--pane ID]         print true/false, exit 1 if false
  pine browse identify [--pane ID]                   print {paneId,url,title,workspaceId,windowId}
  pine browse cookies <get|set|clear> [name] [value] [--url U] [--domain D] [--pane ID]
  pine browse storage <local|session> <get|set|clear> [key] [value] [--pane ID]
  pine browse state <save|load> <path> [--pane ID]   save/restore cookies+localStorage+sessionStorage
  pine browse history clear [--pane ID]              clear this surface's navigation history
  pine browse addscript "<js>" [--pane ID]           run JS now, print the JSON result
  pine browse addstyle "<css>" [--pane ID]           inject a <style>, print its key
  pine browse addinitscript "<js>" [--pane ID]       run JS before every future navigation (CDP)
  pine browse console [list|clear] [--pane ID]       buffered console.* messages (default: list)
  pine browse errors [list|clear] [--pane ID]        error-level/uncaught-exception subset of console
  pine browse frame <selector|main> [--pane ID]      point later selector-driven verbs at an iframe
  pine browse download wait [--path P] [--timeout MS] [--pane ID]  block for this surface's next download
  pine browse navigate <url> [--pane ID]             load <url> on an EXISTING surface (no auto-create)
  pine browse open-split [url] [--pane ID]           always create a NEW browser pane (a split)
  pine browse tab <new|list|switch|close> [url|target] [--pane ID]
                                  cmux-parity "tabs" — pragmatic: a tab here IS a browser pane
  pine browse dialog <accept|dismiss|list> [text] [--pane ID]
                                  auto-response policy + log for alert/confirm/prompt (not blocking)
  pine browse focus-mode <enter|exit|toggle> [--pane ID]  minimal single-pane zoom/zen
  pine browse react-grab <toggle|get> [--pane ID]    minimal React fiber inspector on click
  pine browse pick [--timeout MS] [--pane ID]        ask the user to click an element; prints its capture JSON
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

  Selectors anywhere above also accept an @eN/eN ref from snapshot/find (refs are valid
  until the next navigation).

  pine <command-id> [jsonArgs]   run any registered command by id, with an
                                  optional JSON-encoded args blob
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
    handler: () => ({
      cli: `${CLI_HELP}${extensionHelp(deps.extensions())}`,
      note: 'run `pine commands --json` for the machine-readable command list',
    }),
  })
}
