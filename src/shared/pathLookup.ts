import { delimiter, join } from 'node:path'

export function findOnPath(
  program: string,
  pathEnv: string,
  isExecutable: (path: string) => boolean,
): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, program)
    if (isExecutable(candidate)) return candidate
  }
  return null
}
