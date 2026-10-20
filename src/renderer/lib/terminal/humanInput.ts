import type { HumanInputSource } from '@shared/terminal/ptyApi'

const TYPING_EVENTS = new Set(['keydown', 'keypress', 'input', 'compositionend'])

let pasting = false

export function asHumanPaste(run: () => void): void {
  pasting = true
  try {
    run()
  } finally {
    pasting = false
  }
}

export function humanInputSource(host: HTMLElement): HumanInputSource | undefined {
  if (pasting) return 'paste'
  const event = window.event
  const typed =
    event?.isTrusted === true &&
    TYPING_EVENTS.has(event.type) &&
    event.target instanceof Node &&
    host.contains(event.target)
  return typed ? 'key' : undefined
}
