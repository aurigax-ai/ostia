import type { ChangeArea } from './git'

const CHANGE_LABEL: Record<ChangeArea, string> = {
  staged: 'Index',
  unstaged: 'Working Tree',
  untracked: 'Untracked',
  conflicted: 'Working Tree',
}

export function changeDiffTitle(name: string, area: ChangeArea, code: string): string {
  return `${name} (${code === 'D' ? 'Deleted' : CHANGE_LABEL[area]})`
}

export function commitDiffTitle(name: string, sha: string): string {
  const short = sha.slice(0, 7)
  return `${name} (${short}^) ↔ ${name} (${short})`
}

export function filesDiffTitle(original: string, modified: string): string {
  return `${original} ↔ ${modified}`
}
