import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = __dirname
const PRELOAD_FILE = join(__dirname, '..', 'preload', 'index.ts')

const HANDLER_CALLS = [
  'ipcMain.handle',
  'ipcMain.on',
  'ipcMain.once',
  'ipc.handle',
  'ipc.on',
  'owned',
  'secretAction',
]

const SENT_BY_TESTS_ONLY = ['diagnostics:test-crash']

const PUSHED = [
  'app-menu:run',
  'app:install-replace-state',
  'app:release-available',
  'app:update-available',
  'app:update-progress',
  'app:update-run-state',
  'approvals:changed',
  'artifacts:changed',
  'assist:availability',
  'assist:catalog',
  'assist:chunk',
  'assist:open-ui',
  'assist:overview',
  'browser:pick-state',
  'chatTools:always-grants',
  'chatTools:mcp-status',
  'command:invoke',
  'diagnostics:test-crash',
  'extensions:agent-offer',
  'extensions:agent-offer-withdrawn',
  'extensions:changed',
  'extensions:chips',
  'extensions:focus-pane',
  'extensions:open-diff',
  'extensions:open-panel',
  'extensions:open-terminal',
  'extensions:settings-stored',
  'extensions:sidebar',
  'extensions:workspace-chips',
  'fs:changed',
  'gateway:pair-requests-changed',
  'gateway:tailnet-changed',
  'git:changed',
  'git:items',
  'guest-chords:fire',
  'lsp:servers-changed',
  'manager:open',
  'notifications:activate',
  'notifications:changed',
  'open-waits:ended',
  'ports:items',
  'preview:event',
  'pty:run',
  'questions:changed',
  'reach:agent-groups-changed',
  'remote-files:confirm',
  'remote-files:folders-changed',
  'sandbox:blocked',
  'settings:changed',
  'sync:status',
  'views:changed',
  'window:confirm-close',
  'window:freeze',
  'window:maximized',
  'window:running',
  'window:system-dark-changed',
  'windows:activate-workspace',
  'windows:adopt',
  'windows:list',
  'windows:origin-agents-changed',
  'windows:reference-insert',
  'windows:return-request',
]

const PUSHED_DYNAMIC = ['lsp:exit:', 'lsp:msg:', 'pty:data:', 'pty:exit:', 'pty:size:']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')
      ? [path]
      : []
  })
}

function mainSources(): string[] {
  return sourceFiles(MAIN_DIR).map((file) => readFileSync(file, 'utf8'))
}

function constants(sources: string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const text of sources) {
    for (const m of text.matchAll(/const (\w+) = '([^'\n]+)'/g)) found.set(m[1], m[2])
  }
  return found
}

function handledChannels(sources: string[]): Set<string> {
  const consts = constants(sources)
  const calls = HANDLER_CALLS.map((c) => c.replace('.', '\\.')).join('|')
  const re = new RegExp(`(?:${calls})\\(\\s*(?:'([^'\\n]+)'|([A-Z_]+))`, 'g')
  const handled = new Set<string>()
  for (const text of sources) {
    for (const m of text.matchAll(re)) {
      const channel = m[1] ?? consts.get(m[2])
      if (channel) handled.add(channel)
    }
  }
  return handled
}

function preloadChannels(): { requests: Set<string>; pushes: Set<string>; dynamic: Set<string> } {
  const text = readFileSync(PRELOAD_FILE, 'utf8')
  const requests = new Set<string>()
  const pushes = new Set<string>()
  const dynamic = new Set<string>()
  for (const m of text.matchAll(
    /ipcRenderer\.(invoke|send|sendSync|on|once)\(\s*(['`])([^'`]+)\2/g,
  )) {
    const [, kind, quote, channel] = m
    if (kind === 'on' || kind === 'once') {
      if (quote === '`') dynamic.add(channel.slice(0, channel.indexOf('${')))
      else pushes.add(channel)
    } else {
      requests.add(channel)
    }
  }
  return { requests, pushes, dynamic }
}

describe('preload and main IPC wiring', () => {
  const sources = mainSources()
  const preload = preloadChannels()
  const handled = handledChannels(sources)

  it('reads a plausible number of channels from both sides', () => {
    expect(preload.requests.size).toBeGreaterThan(100)
    expect(handled.size).toBeGreaterThan(100)
  })

  it('has a main handler for every channel the preload invokes or sends', () => {
    const missing = [...preload.requests].filter((c) => !handled.has(c)).sort()
    expect(missing).toEqual([])
  })

  it('lists exactly the channels the preload listens on', () => {
    expect([...preload.pushes].sort()).toEqual(PUSHED)
    expect([...preload.dynamic].sort()).toEqual(PUSHED_DYNAMIC)
  })

  it('sends every listened-on channel from main', () => {
    const joined = sources.join('\n')
    const consts = [...constants(sources).values()]
    const silent = [...PUSHED, ...PUSHED_DYNAMIC].filter(
      (c) =>
        !SENT_BY_TESTS_ONLY.includes(c) &&
        !joined.includes(`'${c}`) &&
        !joined.includes(`\`${c}`) &&
        !consts.includes(c),
    )
    expect(silent).toEqual([])
  })
})
