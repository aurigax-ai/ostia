import { BROWSE_VERBS } from '../verbs/browseArgs'

type Audience = 'agent' | 'admin' | 'plumbing'

interface VerbUsage {
  verb: string
  args?: string
  about: string
  hidden?: true
}

export interface NounUsage {
  noun: string
  about: string
  audience: Audience
  extension?: string
  args?: string
  needsArgs?: true
  verbs?: VerbUsage[]
}

const PANE = '<pane>'
const WORKSPACE_FLAG = '[--workspace <id|name>]'

export const USAGE_TABLE: readonly NounUsage[] = [
  {
    noun: 'whoami',
    audience: 'agent',
    about: 'your pane, workspace and folder, and whether a command runs there (JSON)',
  },
  {
    noun: 'docs',
    audience: 'agent',
    args: '[topic]',
    about:
      'list the topics (skill, git, browser, …) and the extension commands; a topic prints one',
  },
  {
    noun: 'open',
    audience: 'agent',
    needsArgs: true,
    args: '<target>… [-b|--background] [-w|--wait] [--name <file>]',
    about:
      'show a file (file:line[:col]), a folder, an http(s) URL or - (stdin, saved as an artifact)',
  },
  {
    noun: 'diff',
    audience: 'agent',
    needsArgs: true,
    args: '<a> <b> [-b|--background] [-w|--wait]',
    about: 'compare two text files, read-only',
  },
  {
    noun: 'ask',
    audience: 'agent',
    needsArgs: true,
    args: '"<question>" [--context <text|->] [--choice <label>]… [--multi] [--timeout <s>] [--json]',
    about:
      'ask the human and wait; prints the chosen labels, then the reply. Exit 0 answered, 2 dismissed, 3 timed out, 4 pane closed',
  },
  {
    noun: 'state',
    audience: 'agent',
    needsArgs: true,
    args: '<waiting|done|working|error|clear> [message|-] [--pane <pane>]',
    about: "set your pane's attention mark",
  },
  {
    noun: 'notify',
    audience: 'agent',
    needsArgs: true,
    args: '<title> [body]',
    about: 'post a notification for the human',
  },
  {
    noun: 'pane',
    audience: 'agent',
    about: 'the panes you reach: list, type, read, wait, wake, move, close',
    verbs: [
      {
        verb: 'list',
        args: '[--here | --workspace <id|name>] [--state <state>]… [--kind <kind>] [--json]',
        about: 'the panes you can see: id, workspace, kind, state, title, bus name and description',
      },
      {
        verb: 'send',
        args: `${PANE} [--enter] [--paste|--raw] [--force] [--json] [--] <text…|->`,
        about: 'type text into a terminal pane (no Enter unless --enter) and confirm it showed',
      },
      { verb: 'key', args: `${PANE} <key>… [--json]`, about: 'press keys in a terminal pane' },
      { verb: 'read', args: `${PANE} [--lines N] [--json]`, about: 'its screen as plain text' },
      {
        verb: 'status',
        args: `[${PANE}…] [--json]`,
        about:
          'one line per pane: id, state, closing line, exit code, git, mail and what changed since you last asked; no pane means every other terminal in your workspace',
      },
      {
        verb: 'transcript',
        args: `${PANE} [--turns N | --full] [--json]`,
        about: "the agent's own transcript: by default its last turn, as it was written",
      },
      {
        verb: 'wait',
        args: `${PANE}… [--until done|waiting|error|idle|exited|command]… [--timeout <s>] [--json]`,
        about: 'block until one of those panes stops working; prints its status line',
      },
      {
        verb: 'watch',
        args: `${PANE}… [--until done|waiting|error|command|exited]… | --off`,
        about: 'get a message in your inbox when one of those panes reaches a state',
      },
      {
        verb: 'wake',
        args: `${PANE}… [--timeout <s>] [--json]`,
        about: "start a pane's agent again with its own resume command and wait until it started",
      },
      {
        verb: 'hibernate',
        args: `${PANE}… [--json]`,
        about: 'stop idle agent panes to save memory',
      },
      { verb: 'close', args: `[${PANE}…] [--json]`, about: 'close those panes, or your own' },
      {
        verb: 'move',
        args: `${PANE}… [--tab <name>|new] ${WORKSPACE_FLAG} [--json]`,
        about: 'put running panes into a split tab, their own tabs or another workspace',
      },
      { verb: 'rename', args: `${PANE} <title…> | --clear`, about: "name a pane's tab" },
      {
        verb: 'keep-awake',
        args: '[--off] [--json]',
        about:
          'keep your own agent pane awake: automatic hibernation and pane hibernate skip it; --off ends it',
      },
      {
        verb: 'name',
        args: '<name> [--desc <text>] [--json] | --clear',
        about:
          'give your own pane a bus name other agents send to in place of its id; one holder per name, dropped when the pane or its agent ends',
      },
    ],
  },
  {
    noun: 'process',
    audience: 'agent',
    about: 'commands in terminal tabs the human can watch',
    verbs: [
      {
        verb: 'run',
        args: `"<cmd>" [--name N] [--cwd DIR] ${WORKSPACE_FLAG} [--tab <name>]`,
        about: 'run a command in a new terminal tab',
      },
      {
        verb: 'list',
        args: '[--json]',
        about: 'id, name, status, pane and command of each process',
      },
      { verb: 'logs', args: '<id|name> [--since N]', about: "that command's output" },
      { verb: 'kill', args: '<id|name>', about: 'Ctrl+C, then end its shell' },
      { verb: 'restart', args: '<id|name>', about: 'Ctrl+C, then run the same line again' },
    ],
  },
  {
    noun: 'agent',
    audience: 'agent',
    about: 'start another agent in a terminal tab',
    verbs: [
      {
        verb: 'run',
        args: `<agent> [--name N] [--model M] [--cwd DIR] ${WORKSPACE_FLAG} [--tab <name>] [--json] <prompt|->`,
        about:
          'start claude, codex or an agent the human configured with that prompt; answers its pane, whether it took the prompt and its session',
      },
    ],
  },
  {
    noun: 'workspace',
    audience: 'agent',
    about: 'workspaces and their sidebar groups',
    verbs: [
      { verb: 'list', args: '[--json]', about: 'every workspace with its sidebar group' },
      {
        verb: 'new',
        args: '[dir] [--name <name>] [--group <group>] [--no-focus]',
        about: 'open a workspace on a folder (default: the current one)',
      },
      {
        verb: 'describe',
        args: '<text…>',
        about: 'refused: only the human sets a description; leave a note with ostia activity add',
      },
      { verb: 'dir', args: '[path]', about: "make a folder the workspace's folder" },
      {
        verb: 'rename',
        args: '[--workspace <id>] <name…> | --clear',
        about: 'name a workspace',
      },
      {
        verb: 'group',
        args: '[--workspace <id>] <name>',
        about: 'move a workspace into a sidebar group',
      },
      { verb: 'ungroup', args: '[--workspace <id>]', about: 'take a workspace out of its group' },
      {
        verb: 'group-color',
        args: '<group> <red|orange|yellow|green|teal|blue|purple|pink> | <group> --clear',
        about: "set or clear a sidebar group's color",
      },
      { verb: 'group-rename', args: '<group> <name>', about: 'rename a sidebar group' },
      {
        verb: 'group-delete',
        args: '<group>',
        about: 'delete a sidebar group; its workspaces stay',
      },
      { verb: 'pin', args: '[--workspace <id>]', about: 'pin a workspace to the top' },
      { verb: 'unpin', args: '[--workspace <id>]', about: 'unpin a workspace' },
      {
        verb: 'close',
        args: '[--workspace <id>]',
        about: 'close a workspace where nothing runs',
      },
    ],
  },
  {
    noun: 'bus',
    audience: 'agent',
    about: 'messages and handoffs between agents',
    verbs: [
      {
        verb: 'send',
        args: `[--wait <s>] ${PANE} "<msg>"`,
        about:
          'send a message to an agent pane, by id or bus name; --wait blocks until that pane replies (exit 3 timed out)',
      },
      {
        verb: 'inbox',
        args: '[--take] [--json]',
        about: 'messages waiting for you; --take delivers them',
      },
      { verb: 'sent', args: '[--json]', about: 'messages you sent and where each one stands' },
      {
        verb: 'wait',
        args: '[--timeout <s>] [--json]',
        about: 'block until a message arrives; exit 3 timed out',
      },
      {
        verb: 'handoff',
        args: `${PANE} --task "<task>" --summary "<summary>"`,
        about: 'hand a task to an agent',
      },
      { verb: 'claim', args: '<id>', about: 'take a handoff' },
      { verb: 'handoffs', args: '[--all]', about: 'handoffs to you (JSON)' },
      { verb: 'done', args: '<id>', about: 'mark a handoff completed' },
      { verb: 'hook', args: '<event>', about: 'agent hook: add bus context', hidden: true },
    ],
  },
  {
    noun: 'browse',
    audience: 'agent',
    about: 'drive a browser pane',
    verbs: BROWSE_VERBS.map((verb) => ({ verb, about: '' })),
  },
  {
    noun: 'git',
    audience: 'agent',
    about: 'the repository of your folder',
    verbs: [
      { verb: 'status', about: 'branch, upstream and change counts (JSON)' },
      { verb: 'changes', about: 'staged, unstaged and untracked files (JSON)' },
      { verb: 'diff', args: '<path> [--staged]', about: 'unified diff of one changed file (JSON)' },
      { verb: 'open', args: '<path> [--staged]', about: 'open a changed file in the diff view' },
      { verb: 'log', args: '[--limit <n>] [--json]', about: 'recent commits' },
      { verb: 'blame', args: '<file> [--json]', about: 'who last changed each line' },
      { verb: 'stage', args: '<path…> | --all', about: 'stage paths' },
      { verb: 'unstage', args: '<path…> | --all', about: 'unstage paths' },
      { verb: 'commit', args: '-m <message>', about: 'commit the staged changes' },
    ],
  },
  {
    noun: 'ports',
    audience: 'agent',
    about: "listening ports of your workspace's terminals",
    verbs: [{ verb: 'list', args: '[--all]', about: 'listening ports and ssh hosts (JSON)' }],
  },
  {
    noun: 'view',
    audience: 'agent',
    about: 'declarative views: sidebar sections and panels',
    verbs: [
      { verb: 'list', args: '[--json]', about: 'the views and whether each is enabled' },
      { verb: 'open', args: '<name>', about: 'open a view in a panel' },
      { verb: 'validate', args: '<file>', about: 'check a view file' },
      { verb: 'schema', about: 'print the view JSON schema' },
    ],
  },
  {
    noun: 'graph',
    audience: 'agent',
    extension: 'graphs',
    about: 'graphs: procedures the human enabled, run node by node (the graphs extension)',
    verbs: [
      { verb: 'schema', about: "the graph file's JSON Schema" },
      { verb: 'nodes', about: 'the node kinds Ostia runs, their fields and outputs' },
      { verb: 'validate', args: '<file>', about: 'check a graph file' },
      { verb: 'explain', args: '<file>', about: 'an outline: triggers, nodes, edges' },
      {
        verb: 'dry-run',
        args: '<file> [--input k=v]… [--input-json <json>] [--mock <node>=<json>]… [--json]',
        about: 'walk a graph with mocked outputs; nothing runs',
      },
      { verb: 'list', about: "this workspace's graphs and whether each is enabled" },
      { verb: 'runs', args: '[name]', about: 'the runs of a graph' },
      { verb: 'show', args: '<run> [--node <id>]', about: 'a run node by node' },
      {
        verb: 'run',
        args: '<name> [--input key=value]… [--input-json <json>]',
        about: 'start an enabled graph whose manual trigger lets agents start it',
      },
      {
        verb: 'report',
        args: '--json <object> [--run <id>]',
        about: "report an agent node's result",
      },
      { verb: 'open', about: 'open the Graphs panel' },
      { verb: 'on-stop', about: 'agent hook', hidden: true },
    ],
  },
  {
    noun: 'snippet',
    audience: 'agent',
    about: "the human's saved commands, read-only",
    verbs: [
      { verb: 'list', args: '[--json]', about: 'every saved snippet' },
      { verb: 'show', args: '<name> [--json]', about: 'one snippet with its arguments' },
    ],
  },
  {
    noun: 'settings',
    audience: 'agent',
    about: "the app's settings.json",
    verbs: [
      { verb: 'get', args: '[key]', about: 'read a setting or all of them (JSON)' },
      { verb: 'set', args: '<key> <value> [--dry-run]', about: 'write a setting' },
      { verb: 'unset', args: '<key>', about: 'remove a setting' },
      { verb: 'schema', args: '[key]', about: 'the JSON schema of a setting' },
    ],
  },
  {
    noun: 'vault',
    audience: 'agent',
    about: 'encrypted secrets of this project, or --global',
    verbs: [
      { verb: 'set', args: '<KEY> [--global]', about: 'store a secret read from stdin' },
      { verb: 'get', args: '<KEY> [--global]', about: 'print a secret' },
      { verb: 'list', args: '[--global]', about: 'the secret names' },
      { verb: 'rm', args: '<KEY> [--global]', about: 'delete a secret' },
    ],
  },
  {
    noun: 'secret',
    audience: 'agent',
    about: 'secrets a sandboxed workspace may ask for',
    verbs: [
      { verb: 'list', about: 'the secrets you can ask for' },
      { verb: 'get', args: '<name> [--reason <text>]', about: 'ask the human for one' },
    ],
  },
  {
    noun: 'sandbox',
    audience: 'agent',
    about: 'ask from inside a sandboxed workspace',
    verbs: [
      { verb: 'request-domain', args: '<host>', about: 'ask the human to allow a domain' },
      { verb: 'expose', args: '<port>', about: 'make a port reachable on this computer' },
    ],
  },
  {
    noun: 'ext',
    audience: 'agent',
    about: 'extensions; run their commands as ostia <extId> <command>',
    verbs: [{ verb: 'list', about: 'each extension with its status and commands' }],
  },
  {
    noun: 'manager',
    audience: 'agent',
    about: 'the manager pane: read, spawn and type into its workers',
    verbs: [
      { verb: 'read', args: '<paneId> [--lines N]', about: "a worker's screen" },
      {
        verb: 'spawn',
        args: '<preset> [--cwd DIR] [--workspace ID] [--name NAME] [-- args…]',
        about: 'start a worker',
      },
      { verb: 'input', args: '<paneId> [--text TEXT] [--key KEY]…', about: 'type into a worker' },
    ],
  },
  {
    noun: 'commands',
    audience: 'agent',
    about: 'every app command id with its args and capabilities (JSON)',
  },
  {
    noun: 'token',
    audience: 'admin',
    about: 'script tokens for programs outside Ostia',
    verbs: [
      {
        verb: 'create',
        args: '<name> (--cap <capability>… | --preset readonly|coordinator) [--scope …]… [--own-workspaces] [--expires …]',
        about: 'make a token',
      },
      { verb: 'update', args: '<id|name> [--name …] [--cap …] [--scope …]…', about: 'change it' },
      { verb: 'show', args: '<id|name> [--json]', about: 'what it can do and how it was used' },
      { verb: 'list', args: '[--json]', about: 'every token' },
      { verb: 'revoke', args: '<id|name>', about: 'revoke a token' },
    ],
  },
  {
    noun: 'account',
    audience: 'admin',
    about: 'the Claude accounts new sessions can use',
    verbs: [
      {
        verb: 'list',
        args: '[--json]',
        about: 'every account: number, email, which one is current, session and weekly use',
      },
      { verb: 'switch', args: '<email|number>', about: 'the account new Claude sessions start on' },
    ],
  },
  {
    noun: 'gateway',
    audience: 'admin',
    about: 'the phone gateway',
    verbs: [
      { verb: 'pair', about: 'print a pairing code for a phone' },
      { verb: 'status', about: 'whether it runs, and where (JSON)' },
      { verb: 'devices', about: 'paired phones' },
      { verb: 'revoke', args: '<deviceId>', about: 'unpair a phone' },
    ],
  },
  {
    noun: 'polkit',
    audience: 'admin',
    about: 'Linux: let polkit confirm new script tokens',
    verbs: [{ verb: 'install', about: 'install the polkit action (run with sudo)' }],
  },
  {
    noun: 'cmux',
    audience: 'admin',
    about: "cmux's saved session",
    verbs: [
      {
        verb: 'import',
        args: '[session-file] [--json]',
        about: "recreate cmux's workspaces, splits and tabs",
      },
    ],
  },
  { noun: 'resume-token', audience: 'plumbing', needsArgs: true, about: 'agent hook' },
  { noun: 'claude-hook', audience: 'plumbing', needsArgs: true, about: 'agent hook' },
  { noun: 'claude-account', audience: 'plumbing', needsArgs: true, about: 'claude launcher' },
  { noun: 'codex-hook', audience: 'plumbing', needsArgs: true, about: 'agent hook' },
  { noun: 'turn-hook', audience: 'plumbing', needsArgs: true, about: 'agent hook' },
  { noun: 'codex-server', audience: 'plumbing', needsArgs: true, about: 'codex launcher' },
  { noun: 'permission-hook', audience: 'plumbing', needsArgs: true, about: 'agent hook' },
  { noun: 'agent-hook', audience: 'plumbing', needsArgs: true, about: 'agent hook' },
]

const HELP_WORDS = new Set(['--help', '-h', 'help'])

export function findNoun(word: string | undefined): NounUsage | undefined {
  return USAGE_TABLE.find((n) => n.noun === word)
}

function shownVerbs(noun: NounUsage): VerbUsage[] {
  return (noun.verbs ?? []).filter((v) => !v.hidden)
}

export function nounUsage(noun: NounUsage): string {
  const verbs = shownVerbs(noun)
  if (noun.noun === 'browse') {
    return [
      `usage: ostia browse <verb> [args] [--pane <pane>] [--json]   ${noun.about}`,
      `verbs: ${verbs.map((v) => v.verb).join(', ')}`,
    ].join('\n')
  }
  if (verbs.length === 0) {
    return `usage: ostia ${noun.noun}${noun.args ? ` ${noun.args}` : ''}\n  ${noun.about}`
  }
  const lines = verbs.map(
    (v) => `  ostia ${noun.noun} ${v.verb}${v.args ? ` ${v.args}` : ''}\n      ${v.about}`,
  )
  return [`usage: ostia ${noun.noun} <verb>   ${noun.about}`, ...lines].join('\n')
}

export function usageOf(word: string): string {
  const noun = findNoun(word)
  return noun ? nounUsage(noun) : topUsage()
}

function verbLine(noun: NounUsage, verb: VerbUsage): string {
  return `usage: ostia ${noun.noun} ${verb.verb}${verb.args ? ` ${verb.args}` : ''}\n  ${verb.about}`
}

export function verbUsageOf(word: string, verb: string | undefined): string {
  const noun = findNoun(word)
  const known = noun?.verbs?.find((v) => v.verb === verb)
  return noun && known ? verbLine(noun, known) : usageOf(word)
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

function inOrder(word: string, verb: string): boolean {
  let at = 0
  for (const letter of verb) if (letter === word[at]) at += 1
  return at === word.length
}

function nearestVerb(noun: NounUsage, word: string): string | undefined {
  return shownVerbs(noun).find((v) => inOrder(word, v.verb) || distance(word, v.verb) <= 1)?.verb
}

function nounLine(noun: NounUsage): string {
  return `  ${noun.noun.padEnd(12)}${noun.about}`
}

export function topUsage(): string {
  const of = (audience: Audience) => USAGE_TABLE.filter((n) => n.audience === audience)
  return [
    'usage: ostia <noun> <verb> [args]      (ostia <noun> --help for its verbs)',
    '',
    'for agents:',
    ...of('agent').map(nounLine),
    '  <extId>     an extension command: ostia <extId> <command> [args] (see: ostia ext list)',
    '',
    'for the human:',
    ...of('admin').map(nounLine),
    '  ostia <target>… [-b] [-w|--wait]   the same as open, but a folder opens a new workspace',
    '              on it (nothing when it is this workspace\'s folder); EDITOR="ostia --wait"',
    '',
    'any app command by id (see: ostia commands):',
    '  ostia <command.id> [json-args] [--workspace <id|name>]',
    '',
    'ostia --version',
  ].join('\n')
}

function hasVerb(noun: NounUsage, verb: string): boolean {
  return (noun.verbs ?? []).some((v) => v.verb === verb)
}

export interface UsageAnswer {
  text: string
  code: 0 | 1
}

export function usageGate(argv: readonly string[]): UsageAnswer | null {
  const [word, verb] = argv
  if (word === undefined || HELP_WORDS.has(word)) {
    return { text: topUsage(), code: word === undefined ? 1 : 0 }
  }
  const dotted = word.indexOf('.')
  if (dotted > 0) {
    const noun = findNoun(word.slice(0, dotted))
    const replaced = word.slice(dotted + 1)
    return noun && hasVerb(noun, replaced)
      ? { text: `ostia: use 'ostia ${noun.noun} ${replaced}', not '${word}'`, code: 1 }
      : null
  }
  const noun = findNoun(word)
  if (!noun || noun.audience === 'plumbing') return null
  if (verb !== undefined && HELP_WORDS.has(verb)) return { text: nounUsage(noun), code: 0 }
  if (!noun.verbs) {
    return noun.needsArgs && verb === undefined ? { text: nounUsage(noun), code: 1 } : null
  }
  if (verb === undefined) return { text: nounUsage(noun), code: 1 }
  if (verb.startsWith('-')) return null
  if (hasVerb(noun, verb)) {
    const flags = argv.slice(2)
    const end = flags.indexOf('--')
    const asksHelp = (end === -1 ? flags : flags.slice(0, end)).some(
      (arg) => arg === '--help' || arg === '-h',
    )
    return asksHelp ? { text: verbUsageOf(noun.noun, verb), code: 0 } : null
  }
  const near = nearestVerb(noun, verb)
  return near
    ? {
        text: `ostia ${noun.noun}: no verb '${verb}'; did you mean 'ostia ${noun.noun} ${near}'?`,
        code: 1,
      }
    : { text: `ostia ${noun.noun}: no verb '${verb}'\n${nounUsage(noun)}`, code: 1 }
}
