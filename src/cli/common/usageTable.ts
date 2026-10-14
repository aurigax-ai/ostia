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
    about: 'print the agent skill and the commands of the enabled extensions',
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
      { verb: 'list', about: 'every pane you can see (JSON)' },
      {
        verb: 'send',
        args: `${PANE} [--enter] [--paste|--raw] [--force] [--confirm] [--] <text…|->`,
        about: 'type text into a terminal pane; no Enter unless --enter',
      },
      { verb: 'key', args: `${PANE} <key>…`, about: 'press keys in a terminal pane' },
      { verb: 'read', args: `${PANE} [--lines N] [--json]`, about: 'its screen as plain text' },
      {
        verb: 'wait',
        args: `${PANE}… [--until done|waiting|idle|exited]… [--timeout <s>] [--json]`,
        about: 'block until one of those panes stops working',
      },
      {
        verb: 'wake',
        args: `${PANE}… [--wait [--timeout <s>]] [--json]`,
        about: "start a pane's agent again with its own resume command",
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
      { verb: 'list', about: 'id, name, status, pane and command of each process' },
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
        args: `<agent> [--name N] [--cwd DIR] ${WORKSPACE_FLAG} [--tab <name>] <prompt|->`,
        about: 'start claude, codex or an agent the human configured with that prompt',
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
        args: '[--workspace <id>] <text|-> | --clear',
        about: 'the one-line summary under a workspace in the sidebar',
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
      { verb: 'send', args: `${PANE} "<msg>"`, about: 'send a message to an agent pane' },
      { verb: 'inbox', args: '[--drain]', about: 'messages sent to you (JSON)' },
      { verb: 'sent', args: '[--json]', about: 'messages you sent and whether they were read' },
      { verb: 'wait', args: '[--timeout <s>]', about: 'block until a message arrives' },
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
    const replaced = noun && hasVerb(noun, word.slice(dotted + 1))
    return replaced ? { text: nounUsage(noun), code: 1 } : null
  }
  const noun = findNoun(word)
  if (!noun || noun.audience === 'plumbing') return null
  if (verb !== undefined && HELP_WORDS.has(verb)) return { text: nounUsage(noun), code: 0 }
  if (!noun.verbs) {
    return noun.needsArgs && verb === undefined ? { text: nounUsage(noun), code: 1 } : null
  }
  if (verb === undefined) return { text: nounUsage(noun), code: 1 }
  if (verb.startsWith('-') || hasVerb(noun, verb)) return null
  return { text: nounUsage(noun), code: 1 }
}
