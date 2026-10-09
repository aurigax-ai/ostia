import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = __dirname
const PRELOAD_FILE = join(__dirname, '..', 'preload', 'index.ts')

const HANDLE_CALLS = ['ipcMain.handle', 'ipc.handle', 'owned', 'secretAction']

const ON_CALLS = ['ipcMain.on', 'ipcMain.once', 'ipc.on']

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

function registrations(calls: string[]): RegExp {
  const names = calls.map((c) => c.replace('.', '\\.')).join('|')
  return new RegExp(`\\b(?:${names})\\(\\s*(?:'([^'\\n]+)'|([A-Z_]+)\\b)`, 'g')
}

function registeredChannels(sources: string[], calls: string[]): Set<string> {
  const consts = constants(sources)
  const found = new Set<string>()
  for (const text of sources) {
    for (const m of text.matchAll(registrations(calls))) {
      const channel = m[1] ?? consts.get(m[2])
      if (channel) found.add(channel)
    }
  }
  return found
}

function withoutRegistrations(sources: string[]): string {
  const handlers = registrations([...HANDLE_CALLS, ...ON_CALLS])
  return sources
    .map((text) => text.replace(handlers, '').replace(/const \w+ = '[^'\n]+'/g, ''))
    .join('\n')
}

function sentChannels(sources: string[]): Set<string> {
  const rest = withoutRegistrations(sources)
  const sent = new Set<string>()
  for (const m of rest.matchAll(/'([^'\n]+)'/g)) sent.add(m[1])
  for (const m of rest.matchAll(/`([^`$\n]+)\$\{/g)) sent.add(m[1])
  for (const [name, value] of constants(sources)) {
    if (new RegExp(`\\b${name}\\b`).test(rest)) sent.add(value)
  }
  return sent
}

type PreloadKind = 'invoke' | 'send' | 'listen'

function preloadChannels(): Record<PreloadKind, Set<string>> & { dynamic: Set<string> } {
  const text = readFileSync(PRELOAD_FILE, 'utf8')
  const found = {
    invoke: new Set<string>(),
    send: new Set<string>(),
    listen: new Set<string>(),
    dynamic: new Set<string>(),
  }
  for (const m of text.matchAll(
    /ipcRenderer\.(invoke|send|sendSync|on|once)\(\s*(['`])([^'`]+)\2/g,
  )) {
    const [, kind, quote, channel] = m
    if (kind === 'invoke') found.invoke.add(channel)
    else if (kind === 'send' || kind === 'sendSync') found.send.add(channel)
    else if (quote === '`') found.dynamic.add(channel.slice(0, channel.indexOf('${')))
    else found.listen.add(channel)
  }
  return found
}

function missingFrom(wanted: Iterable<string>, have: Set<string>): string[] {
  return [...wanted].filter((c) => !have.has(c)).sort()
}

describe('preload and main IPC wiring', () => {
  const sources = mainSources()
  const preload = preloadChannels()
  const handled = registeredChannels(sources, HANDLE_CALLS)
  const listened = registeredChannels(sources, ON_CALLS)
  const sent = sentChannels(sources)

  it('reads a plausible number of channels from both sides', () => {
    expect(preload.invoke.size).toBeGreaterThan(100)
    expect(preload.send.size).toBeGreaterThan(30)
    expect(handled.size).toBeGreaterThan(100)
    expect(listened.size).toBeGreaterThan(30)
  })

  it('has a main handle for every channel the preload invokes', () => {
    expect(missingFrom(preload.invoke, handled)).toEqual([])
  })

  it('has a main listener for every channel the preload sends', () => {
    expect(missingFrom(preload.send, listened)).toEqual([])
  })

  it('lists exactly the channels the preload listens on', () => {
    expect([...preload.listen].sort()).toEqual(PUSHED)
    expect([...preload.dynamic].sort()).toEqual(PUSHED_DYNAMIC)
  })

  it('sends every listened-on channel from main outside its handler registration', () => {
    const silent = missingFrom(
      [...PUSHED, ...PUSHED_DYNAMIC].filter((c) => !SENT_BY_TESTS_ONLY.includes(c)),
      sent,
    )
    expect(silent).toEqual([])
  })
})
