const SEEK_KEY_SECONDS = 5
export const SEEK_BUTTON_SECONDS = 10
const VOLUME_STEP = 0.1

export type MediaAction =
  | { type: 'toggle' }
  | { type: 'seek'; seconds: number }
  | { type: 'volume'; delta: number }
  | { type: 'mute' }
  | { type: 'loop' }

export interface KeyInput {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function mediaKeyAction(input: KeyInput): MediaAction | null {
  if (input.ctrlKey || input.altKey || input.metaKey) return null
  switch (input.key) {
    case ' ':
      return { type: 'toggle' }
    case 'ArrowLeft':
      return { type: 'seek', seconds: -SEEK_KEY_SECONDS }
    case 'ArrowRight':
      return { type: 'seek', seconds: SEEK_KEY_SECONDS }
    case 'ArrowUp':
      return { type: 'volume', delta: VOLUME_STEP }
    case 'ArrowDown':
      return { type: 'volume', delta: -VOLUME_STEP }
    case 'm':
    case 'M':
      return { type: 'mute' }
    case 'l':
    case 'L':
      return { type: 'loop' }
    default:
      return null
  }
}

export function nextVolume(current: number, delta: number): number {
  return Math.round(Math.min(Math.max(current + delta, 0), 1) * 100) / 100
}
