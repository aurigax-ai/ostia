export const KEEP_SHELLS_FEATURE = 'keep-shells'
export const TMUX_MIN_VERSION = '3.2'

export function parseKeepShells(raw: unknown): boolean {
  return raw === true
}
