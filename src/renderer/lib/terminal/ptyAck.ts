import { PTY_ACK_CHARS } from '@shared/terminal/ptyFlow'

export interface PtyAcker {
  written(chars: number): void
}

export function createPtyAcker(send: (chars: number) => void): PtyAcker {
  let unsent = 0
  return {
    written: (chars) => {
      unsent += chars
      if (unsent < PTY_ACK_CHARS) return
      send(unsent)
      unsent = 0
    },
  }
}
