export const ESC_ARM_MS = 1000
export const ESC_CLEARED_MS = 3000

export type EscAction = 'normal' | 'dismiss' | 'arm' | 'clear' | 'none'

export function escAction({
  vim,
  suggestion,
  clears,
  text,
  armed,
}: {
  vim: boolean
  suggestion: boolean
  clears: boolean
  text: string
  armed: boolean
}): EscAction {
  if (vim) return 'normal'
  if (suggestion) return 'dismiss'
  if (!clears || text === '') return 'none'
  return armed ? 'clear' : 'arm'
}
