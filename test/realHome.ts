import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

export function insideRealHome(path: string): boolean {
  const rel = relative(homedir(), path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
