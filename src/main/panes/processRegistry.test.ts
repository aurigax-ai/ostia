import { describe, expect, it } from 'vitest'
import { GATEKEEPER_WINDOW_MS } from '../../shared/panes/gatekeeperKill'
import { PtyRingBuffer } from '../terminal/ptyRingBuffer'
import { ProcessRegistry } from './processRegistry'

const PROMPT = '\x1b]133;A\x1b\\% \x1b]133;B\x1b\\'
const C = '\x1b]133;C\x1b\\'
const exit = (code: number): string => `\x1b]133;D;${code}\x1b\\`

function setup(platform: NodeJS.Platform) {
  let clock = 1_000_000
  let mono = 5
  const ring = new PtyRingBuffer()
  const registry = new ProcessRegistry({
    ring: () => (from) => ring.since(from),
    workspaceOfPane: () => 'ws1',
    now: () => new Date(clock),
    platform,
    monotonicMs: () => mono,
  })
  const entry = registry.add({
    name: 'tool',
    cmd: 'tool',
    cwd: undefined,
    workspaceId: 'ws1',
    ownerPaneId: 'owner',
    paneId: 'tab-1',
    externalPaneId: 'ext-1',
  })
  const emit = (data: string): void => {
    ring.push(data)
    registry.feed('tab-1', data, ring.end)
  }
  const advance = (ms: number): void => {
    clock += ms
    mono += ms
  }
  const jumpWall = (ms: number): void => {
    clock += ms
  }
  return { registry, entry, emit, advance, jumpWall }
}

function runFor(platform: NodeJS.Platform, ms: number, code: number) {
  const { registry, entry, emit, advance } = setup(platform)
  advance(60_000)
  emit(`${PROMPT}tool\r\n${C}`)
  advance(ms)
  emit(`${exit(code)}${PROMPT}`)
  return registry.info(entry)
}

describe('ProcessRegistry Gatekeeper hint', () => {
  it('adds the hint to a process killed within the window on macOS', () => {
    const info = runFor('darwin', 2000, 137)
    expect(info.exitCode).toBe(137)
    expect(info.hint).toContain('Gatekeeper may have ended')
    expect(info.hint).toContain('Privacy_DevTools')
  })

  it('counts from the command start, not from when the tab opened', () => {
    const { registry, entry, emit, advance } = setup('darwin')
    advance(120_000)
    emit(`${PROMPT}tool\r\n${C}`)
    advance(500)
    emit(`${exit(137)}${PROMPT}`)
    expect(registry.info(entry).hint).toBeDefined()
  })

  it('has no hint at or past the window', () => {
    expect(runFor('darwin', GATEKEEPER_WINDOW_MS - 1, 137).hint).toBeDefined()
    expect(runFor('darwin', GATEKEEPER_WINDOW_MS, 137).hint).toBeUndefined()
    expect(runFor('darwin', 60_000, 137).hint).toBeUndefined()
  })

  it('has no hint on Linux or for another exit code', () => {
    expect(runFor('linux', 1000, 137).hint).toBeUndefined()
    expect(runFor('darwin', 1000, 1).hint).toBeUndefined()
    expect(runFor('darwin', 1000, 130).hint).toBeUndefined()
    expect(runFor('darwin', 1000, 0).hint).toBeUndefined()
  })

  it('has no hint while the command runs or when the shell ended without a code', () => {
    const { registry, entry, emit, advance } = setup('darwin')
    emit(`${PROMPT}tool\r\n${C}`)
    advance(100)
    expect(registry.info(entry).hint).toBeUndefined()
    registry.shellEnded('tab-1', () => ({ data: '', cursor: 0, dropped: false }))
    expect(registry.info(entry).exitCode).toBeUndefined()
    expect(registry.info(entry).hint).toBeUndefined()
  })

  it('clears the hint and the timing when the process is run again', () => {
    const { registry, entry, emit, advance } = setup('darwin')
    emit(`${PROMPT}tool\r\n${C}`)
    advance(300)
    emit(`${exit(137)}${PROMPT}`)
    expect(registry.info(entry).hint).toBeDefined()
    expect(entry.ranMs).toBe(300)
    registry.rerun(entry)
    expect(registry.info(entry).hint).toBeUndefined()
    expect(entry.ranMs).toBeUndefined()
    advance(60_000)
    registry.shellEnded('tab-1', () => ({ data: '', cursor: 0, dropped: false }))
    expect(entry.ranMs).toBeUndefined()
    expect(registry.info(entry).hint).toBeUndefined()
  })

  it('times the second run on its own', () => {
    const { registry, entry, emit, advance } = setup('darwin')
    emit(`${PROMPT}tool\r\n${C}`)
    advance(300)
    emit(`${exit(137)}${PROMPT}`)
    registry.rerun(entry)
    emit(`${PROMPT}tool\r\n${C}`)
    advance(60_000)
    emit(`${exit(137)}${PROMPT}`)
    expect(registry.info(entry).hint).toBeUndefined()
  })

  it('ignores a wall-clock jump while the command ran', () => {
    const { registry, entry, emit, advance, jumpWall } = setup('darwin')
    emit(`${PROMPT}tool\r\n${C}`)
    advance(60_000)
    jumpWall(-3_600_000)
    emit(`${exit(137)}${PROMPT}`)
    expect(registry.info(entry).hint).toBeUndefined()
    const fast = setup('darwin')
    fast.emit(`${PROMPT}tool\r\n${C}`)
    fast.advance(500)
    fast.jumpWall(3_600_000)
    fast.emit(`${exit(137)}${PROMPT}`)
    expect(fast.registry.info(fast.entry).hint).toBeDefined()
  })
})
