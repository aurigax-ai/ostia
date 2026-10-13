export const PRIMARY_SELECTION_MAX_CHARS = 1024 * 1024

export function acceptsPrimarySelection(platform: string, text: unknown): text is string {
  return (
    platform === 'linux' &&
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= PRIMARY_SELECTION_MAX_CHARS
  )
}
