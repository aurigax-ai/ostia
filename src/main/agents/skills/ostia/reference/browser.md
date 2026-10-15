# Browser panes: ostia browse

## Contents

- The core loop
- Every verb
- Output, tabs, refs and profiles
- Console, dialogs and DevTools
- Signing in with the human's saved logins
- Asking the human to point at an element

`ostia browse` takes the command contract of agent-browser (verbs, arguments, `@eN` refs,
`--json`) and drives Ostia's browser panes, which the human sees beside the terminal. Every verb
needs the `browse` capability.

## The core loop

```sh
ostia browse open localhost:3000        # loads the URL; opens your own browser pane if you have none
ostia browse snapshot -i                # interactive elements with refs:  - button "Submit" [ref=e2]
ostia browse fill @e3 "ada@example.com"
ostia browse click @e2
ostia browse wait --text "Welcome"      # then snapshot again: a navigation resets refs
ostia browse snapshot -i --json         # {"success":true,"data":{"snapshot":"…","refs":{…}},"error":null}
```

## Every verb

```sh
# navigation
ostia browse open [url]                 # no scheme: https:// (http:// for localhost and 127.x)
ostia browse back | forward | reload
ostia browse close                      # closes the browser pane
ostia browse read                       # the page's visible text
ostia browse pushstate <url>            # SPA navigation
# page analysis
ostia browse snapshot [-i] [-c] [-d N] [-s <selector>] [-u]
                                        # -i interactive only, -c compact, -d depth, -s scope, -u link URLs
ostia browse get text|html|value <sel>
ostia browse get attr <sel> <name>
ostia browse get title | url
ostia browse get count <sel> | box <sel> | styles <sel> [property]
ostia browse is visible|enabled|checked <sel>
# interaction (sel = @eN, a CSS selector, text=Label or xpath=//…)
ostia browse click <sel> [--new-tab]    # a real click; fails "covered by <div#x>" when something is on top
ostia browse dblclick <sel> | hover <sel> | focus <sel>
ostia browse fill <sel> <text>          # clears, then sets
ostia browse type <sel> <text>          # key events at the end of the field
ostia browse press <key>                # Enter, Tab, Control+a, Shift+ArrowDown …
ostia browse keydown <key> | keyup <key>
ostia browse keyboard type <text> | keyboard inserttext <text>
ostia browse select <sel> <value…>
ostia browse check <sel> | uncheck <sel>
ostia browse scroll [up|down|left|right] [px] [--selector <sel>]
ostia browse scrollintoview <sel>
ostia browse drag <from> <to>
ostia browse upload <sel> <file…>
ostia browse mouse move <x> <y> | down [button] | up [button] | wheel <dy> [dx]
# semantic locators (default action: click)
ostia browse find role <role> [action] [--name <name>] [--exact]
ostia browse find text|label|placeholder|alt|title|testid <value> [action] [text]
ostia browse find first|last <sel> [action] | find nth <index> <sel> [action]
                                        # actions: click, fill <text>, type <text>, check, uncheck, hover, text
# waiting (default 25 s, --timeout <ms>, at most 120 s)
ostia browse wait <sel> [--state visible|hidden|attached|detached]
ostia browse wait <ms> | --text <text> | --url <glob> | --load load|domcontentloaded|networkidle | --fn <js>
ostia browse wait --download [path]
# javascript
ostia browse eval <js> | eval -b <base64> | eval --stdin
ostia browse addinitscript <js>         # runs before every later page load; prints its identifier
ostia browse removeinitscript <identifier>
ostia browse addstyle <css>
# output
ostia browse screenshot [path] [--full] # PNG; prints the path
ostia browse pdf <path>
# state
ostia browse cookies [get] [--url U]
ostia browse cookies set <name> <value> [--url U] [--domain D] [--path P] [--httpOnly] [--secure] [--sameSite Strict|Lax|None] [--expires <epoch s>]
ostia browse cookies clear
ostia browse storage local|session [key]
ostia browse storage local|session set <key> <value> | clear
ostia browse state save|load <path>     # cookies and both storage areas as JSON
# network and emulation
ostia browse network requests [--filter <text>] [--type xhr,fetch] [--method POST] [--status 2xx|404|400-499] [--clear]
ostia browse network request <requestId>
ostia browse network route <url-glob> [--abort] [--body <json>]
ostia browse network unroute [url-glob]
ostia browse set viewport <w> <h> [scale] | media [dark|light] [reduced-motion] | offline [on|off]
ostia browse set headers '<json>' | geo <lat> <lng>
# tabs, frames, dialogs, debugging
ostia browse tab                        # * marks the tab commands go to
ostia browse tab new [url] | tab <tabId> | tab close [tabId]
ostia browse frame <sel|@ref|main>
ostia browse dialog accept [text] | dismiss | status
ostia browse console [--clear] | errors [--clear]
ostia browse highlight <sel>
ostia browse inspect                    # opens DevTools for the human
# many commands over one connection
ostia browse batch [--bail] "open x.test" "snapshot -i" "click @e1"
echo '[["open","x.test"],["snapshot","-i"]]' | ostia browse batch --json
# Ostia only
ostia browse identify                   # {tabId, url, title, workspaceId, windowId}
ostia browse zoom in|out|reset
ostia browse history clear
ostia browse focus-mode enter|exit|toggle
ostia browse react-grab toggle|get      # the human clicks a React element: {component, file, line}
ostia browse focus-webview | is-webview-focused
ostia browse pick [--timeout MS]        # asks the human to click an element
ostia browse login [--user <name>]      # fills the human's saved login
```

Not available: launch, session, profile and connect options, `clipboard`, `diff`, `trace`,
`profiler`, `record`, HAR, `react tree`, `vitals`, `a11y`, `screenshot --annotate`,
`set device|credentials`, `window new` and tab labels.

## Output, tabs, refs and profiles

Every verb takes `--pane <paneId>` and `--json`. `--json` prints
`{"success": bool, "data": {…} | null, "error": "code: detail" | null}`; without it, text on
stdout, and `ostia browse <verb>: <error>` on stderr with exit 1. Relative paths resolve against
your folder and must stay under the home folder.

A tab is a browser pane of your workspace; its id is the pane's id. Commands go to the tab
`open`, `tab new` or `tab <id>` last chose, else the first browser pane of your workspace that is
not on the human's profile. Another workspace's pane needs `--pane` and `all-workspaces`.

`snapshot` and `find` give each element an `eN` ref that holds while the element stays in the
page; a navigation resets them. Same-origin iframes are inlined; `frame <sel>` scopes to one
iframe, `frame main` goes back.

A browser pane you open has its own in-memory cookie and storage jar, gone when it closes.
Panes the human opened share the human's persistent profile; `tab` lists them as
`[the human's browser profile…]`, `open` never uses one, and every command aimed at one asks the
human for `credentials`, every time. Scratch and sandboxed workspaces never use the human's
profile.

## Console, dialogs and DevTools

`console` and `errors` hold 500 entries each from the moment the pane opens; `errors` includes
uncaught exceptions and unhandled rejections. `alert` is logged; `confirm` and `prompt` follow the
policy `dialog accept [text]` or `dialog dismiss` set (default dismiss, reset on each
navigation). Verbs that use the page's debugger (`addinitscript`, `upload`, `screenshot --full`,
`set`, `network route`, request logging) fail while the human has DevTools open on that pane.
`set viewport` fails with `device-mode` while the human has device mode on in that pane.

## Signing in with the human's saved logins

`ostia browse login [--user <name>]` fills the saved login for the current site's exact origin
into its form. Every call asks the human for `credentials`; it returns `{origin, username}`,
never the password, and `no-login` when none is saved. Submit the form with `ostia browse click`.

## Asking the human to point at an element

`ostia browse pick` puts the browser pane into inspect mode with the notice "An agent asked you
to point at an element", waits for the human's click (default 120 s, `--timeout` 1 s–10 min;
Esc cancels) and prints
`{id,url,title,selector,label,html,htmlTruncated,box,styles,role,name,consoleErrors,failedRequests,screenshotPath,capturedAt}`.
It fails with `cancelled`, `timeout`, `navigated` or `busy`. Only the human starts a region
capture; `ostia browse screenshot` takes a picture.
