import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SandboxReadRules } from '../sandbox/visibility'
import {
  HISTORY_ENTRIES_MAX,
  HISTORY_READ_MAX_BYTES,
  type HistoryPane,
  historyShell,
  paneHistory,
  parseBashHistory,
  parseZshHistory,
  ShellHistoryFiles,
} from './shellHistory'

const OWNER = '7'
const PANE = 'pane-1'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-shell-history-')))
})

describe('parseZshHistory', () => {
  it('reads the plain format, one command a line, with no times', () => {
    expect(parseZshHistory(Buffer.from('ls -la\ngit status\n'))).toEqual([
      { command: 'ls -la', time: null },
      { command: 'git status', time: null },
    ])
  })

  it('reads the extended format with its start times', () => {
    const text = ': 1700000000:0;git checkout main\n: 1700000060:12;pnpm test\n'
    expect(parseZshHistory(Buffer.from(text))).toEqual([
      { command: 'git checkout main', time: 1_700_000_000_000 },
      { command: 'pnpm test', time: 1_700_000_060_000 },
    ])
  })

  it('joins a continued command into one entry', () => {
    const text = ': 1700000000:0;for f in *; do\\\n  echo $f\\\ndone\n: 1700000001:0;ls\n'
    expect(parseZshHistory(Buffer.from(text))).toEqual([
      { command: 'for f in *; do\n  echo $f\ndone', time: 1_700_000_000_000 },
      { command: 'ls', time: 1_700_000_001_000 },
    ])
  })

  it('undoes zsh’s metafied bytes', () => {
    const metafied = Buffer.concat([
      Buffer.from('echo voil'),
      Buffer.from([0xc3, 0x83, 0x80]),
      Buffer.from('\n'),
    ])
    expect(parseZshHistory(metafied)).toEqual([{ command: 'echo voilà', time: null }])
  })
})

describe('parseBashHistory', () => {
  it('reads one command a line when the file has no times', () => {
    expect(parseBashHistory('ls -la\n\ngit status\n')).toEqual([
      { command: 'ls -la', time: null },
      { command: 'git status', time: null },
    ])
  })

  it('reads #<time> lines as the time of the command below them', () => {
    const text = '#1700000000\ngit checkout main\n#1700000060\nfor f in *; do\n  echo $f\ndone\n'
    expect(parseBashHistory(text)).toEqual([
      { command: 'git checkout main', time: 1_700_000_000_000 },
      { command: 'for f in *; do\n  echo $f\ndone', time: 1_700_000_060_000 },
    ])
  })
})

describe('historyShell', () => {
  it('knows zsh and bash by their program name and no other shell', () => {
    expect(historyShell('/bin/zsh')).toBe('zsh')
    expect(historyShell('-bash')).toBe('bash')
    expect(historyShell('/usr/bin/fish')).toBeNull()
    expect(historyShell('')).toBeNull()
  })
})

describe('ShellHistoryFiles', () => {
  it('keeps only the last entries of a file over the entry cap', async () => {
    const file = join(root, 'history')
    const lines = Array.from({ length: HISTORY_ENTRIES_MAX + 5 }, (_, i) => `echo ${i}`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    const entries = await new ShellHistoryFiles().read(file, 'zsh')
    expect(entries).toHaveLength(HISTORY_ENTRIES_MAX)
    expect(entries[0].command).toBe('echo 5')
    expect(entries.at(-1)?.command).toBe(`echo ${HISTORY_ENTRIES_MAX + 4}`)
  })

  it('reads only the end of a file over the byte cap, from a whole line', async () => {
    const file = join(root, 'history')
    const filler = `echo ${'x'.repeat(1017)}\n`
    const count = HISTORY_READ_MAX_BYTES / filler.length + 10
    writeFileSync(file, `echo first\n${filler.repeat(count)}echo last\n`)
    const entries = await new ShellHistoryFiles().read(file, 'bash')
    expect(entries.length).toBeLessThanOrEqual(HISTORY_READ_MAX_BYTES / filler.length)
    expect(entries[0].command).toBe(filler.trim())
    expect(entries.at(-1)?.command).toBe('echo last')
  })

  it('refuses a symlink, a folder, a relative path and a missing file', async () => {
    const file = join(root, 'history')
    writeFileSync(file, 'ls\n')
    symlinkSync(file, join(root, 'link'))
    mkdirSync(join(root, 'folder'))
    const files = new ShellHistoryFiles()
    expect(await files.read(join(root, 'link'), 'zsh')).toEqual([])
    expect(await files.read(join(root, 'folder'), 'zsh')).toEqual([])
    expect(await files.read('history', 'zsh')).toEqual([])
    expect(await files.read(join(root, 'missing'), 'zsh')).toEqual([])
    expect(await files.read(file, 'zsh')).toEqual([{ command: 'ls', time: null }])
  })

  it('reads the file again only when its size or time changed', async () => {
    const file = join(root, 'history')
    writeFileSync(file, 'ls\n')
    const files = new ShellHistoryFiles()
    const first = await files.read(file, 'zsh')
    expect(await files.read(file, 'zsh')).toBe(first)
    writeFileSync(file, 'ls\npwd\n')
    expect((await files.read(file, 'zsh')).map((e) => e.command)).toEqual(['ls', 'pwd'])
  })
})

describe('paneHistory', () => {
  let histFile: string
  let stateFile: string

  function deps(over: Partial<HistoryPane> = {}, enabled = true) {
    const pane: HistoryPane = {
      owners: new Set([OWNER]),
      localPrompt: true,
      shell: '/bin/zsh',
      stateFile,
      rules: null,
      ...over,
    }
    return {
      enabled: () => enabled,
      pane: (paneId: string) => (paneId === PANE ? pane : null),
      files: new ShellHistoryFiles(),
    }
  }

  beforeEach(() => {
    histFile = join(root, 'home', '.zsh_history')
    stateFile = join(root, 'state')
    mkdirSync(join(root, 'home'))
    writeFileSync(histFile, ': 1700000000:0;git checkout main\n')
    writeFileSync(stateFile, `/usr/bin\n\n\n\nls cd\n${histFile}\n`)
  })

  const expected = [{ command: 'git checkout main', time: 1_700_000_000_000 }]

  it('answers the owner window with the commands and times of the file the shell reported', async () => {
    expect(await paneHistory(deps(), OWNER, PANE)).toEqual(expected)
  })

  it('refuses a window that does not own the pane and an unknown pane', async () => {
    expect(await paneHistory(deps(), '8', PANE)).toEqual([])
    expect(await paneHistory(deps(), OWNER, 'pane-2')).toEqual([])
    expect(await paneHistory(deps(), OWNER, 5)).toEqual([])
  })

  it('refuses a pane whose terminal a remote or other program holds', async () => {
    expect(await paneHistory(deps({ localPrompt: false }), OWNER, PANE)).toEqual([])
  })

  it('reads nothing while history suggestions are off', async () => {
    expect(await paneHistory(deps({}, false), OWNER, PANE)).toEqual([])
  })

  it('gives a sandboxed pane its file only when the read rules show it', async () => {
    const hidden: SandboxReadRules = { denyRead: [join(root, 'home')], allowRead: [] }
    const shown: SandboxReadRules = { denyRead: [join(root, 'home')], allowRead: [histFile] }
    expect(await paneHistory(deps({ rules: hidden }), OWNER, PANE)).toEqual([])
    expect(await paneHistory(deps({ rules: shown }), OWNER, PANE)).toEqual(expected)
  })

  it('has nothing for a shell it has no parser for or that reported no file', async () => {
    expect(await paneHistory(deps({ shell: '/usr/bin/fish' }), OWNER, PANE)).toEqual([])
    writeFileSync(stateFile, '/usr/bin\n\n\n\nls cd\n')
    expect(await paneHistory(deps(), OWNER, PANE)).toEqual([])
  })
})
