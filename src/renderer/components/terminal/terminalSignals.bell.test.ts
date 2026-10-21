import type { NotificationSettings } from '@shared/app/notificationSettings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { createTerminalSession } from './terminalSession'
import { attachTerminalSignals } from './terminalSignals'

const reduced = vi.hoisted(() => ({ value: false }))
const visible = vi.hoisted(() => ({ value: true }))

vi.mock('@/lib/app/motion', () => ({ reducedMotionNow: () => reduced.value }))

vi.mock('@/lib/attention/workspaceActivity', () => ({
  isPaneViewed: () => false,
  isPaneVisible: () => visible.value,
  signalPane: () => undefined,
}))

function fakeTerm(): {
  term: Parameters<typeof attachTerminalSignals>[0]['term']
  ring: () => void
} {
  let onBell: () => void = () => undefined
  const handle = { dispose: () => undefined }
  const term = {
    parser: { registerOscHandler: () => handle },
    onSelectionChange: () => handle,
    onTitleChange: () => handle,
    onBell: (cb: () => void) => {
      onBell = cb
      return handle
    },
    hasSelection: () => false,
    getSelection: () => '',
    options: { theme: { foreground: '#123456' } },
  } as unknown as Parameters<typeof attachTerminalSignals>[0]['term']
  return { term, ring: () => onBell() }
}

let stack: HTMLElement
let host: HTMLElement
let initial: ReturnType<typeof useSettingsStore.getState>

function attach(replaying = false): { ring: () => void; detach: () => void } {
  const { term, ring } = fakeTerm()
  const session = createTerminalSession(null)
  session.replaying = replaying
  const detach = attachTerminalSignals({
    host,
    term,
    paneId: 'p1',
    workspaceIdRef: { current: 'w1' },
    session,
  })
  return { ring, detach }
}

function setNotifications(patch: Partial<NotificationSettings>): void {
  const current = useSettingsStore.getState().notifications
  useSettingsStore.setState({ notifications: { ...current, ...patch } })
}

const flashes = (): number => stack.querySelectorAll('.bell-flash').length

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  initial = useSettingsStore.getState()
  window.ostia = { window: { beep: vi.fn() } } as unknown as typeof window.ostia
  stack = document.createElement('div')
  stack.className = 'terminal-stack'
  host = document.createElement('div')
  stack.appendChild(host)
  document.body.appendChild(stack)
  reduced.value = false
  visible.value = true
  setNotifications({ visualBell: true, bell: 'off' })
})

afterEach(() => {
  vi.useRealTimers()
  useSettingsStore.setState(initial, true)
  stack.remove()
})

describe('visual bell in the terminal signals', () => {
  it('flashes the terminal stack when the bell rings and the setting is on', () => {
    const { ring } = attach()
    ring()
    expect(flashes()).toBe(1)
  })

  it('flashes once for a burst of bells inside the duration', () => {
    setNotifications({ visualBellMs: 400 })
    const { ring } = attach()
    ring()
    vi.advanceTimersByTime(100)
    ring()
    ring()
    expect(flashes()).toBe(1)
    vi.advanceTimersByTime(400)
    expect(flashes()).toBe(0)
  })

  it('flashes again after the duration', () => {
    setNotifications({ visualBellMs: 400 })
    const { ring } = attach()
    ring()
    vi.advanceTimersByTime(500)
    expect(flashes()).toBe(0)
    ring()
    expect(flashes()).toBe(1)
  })

  it('does not flash while the setting is off', () => {
    setNotifications({ visualBell: false })
    attach().ring()
    expect(flashes()).toBe(0)
  })

  it('flashes in the terminal theme foreground so it shows on any scheme', () => {
    attach().ring()
    const el = stack.querySelector<HTMLElement>('.bell-flash')
    expect(el?.style.getPropertyValue('--bell-flash-color')).toBe('#123456')
  })

  it('does not flash a pane that is not visible', () => {
    visible.value = false
    attach().ring()
    expect(flashes()).toBe(0)
  })

  it('flashes once for a continuous stream of bells and again after it goes quiet', () => {
    const added = vi.spyOn(stack, 'appendChild')
    const { ring } = attach()
    for (let i = 0; i < 20; i++) {
      ring()
      vi.advanceTimersByTime(100)
    }
    expect(added).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(400)
    ring()
    expect(added).toHaveBeenCalledTimes(2)
  })

  it('does not flash under reduced motion', () => {
    reduced.value = true
    attach().ring()
    expect(flashes()).toBe(0)
  })

  it('does not flash while restored output replays', () => {
    attach(true).ring()
    expect(flashes()).toBe(0)
  })

  it('removes a running flash when the terminal detaches', () => {
    const { ring, detach } = attach()
    ring()
    detach()
    expect(flashes()).toBe(0)
  })
})
