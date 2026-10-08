import type { Dict } from '../../shared/dict'

export type GitText = Dict['git']

const MAX_LISTED = 12

export function listedPaths(paths: string[], text: GitText): string {
  const shown = paths.slice(0, MAX_LISTED).join('\n')
  if (paths.length <= MAX_LISTED) return shown
  return `${shown}\n${text.discardMore.replace('{count}', String(paths.length - MAX_LISTED))}`
}
