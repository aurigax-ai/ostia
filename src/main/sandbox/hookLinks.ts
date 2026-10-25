import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

function regularTarget(link: string): string | null {
  try {
    if (!lstatSync(link).isSymbolicLink()) return null
    const target = realpathSync(link)
    return statSync(target).isFile() ? target : null
  } catch {
    return null
  }
}

export function hookLinkTargets(home: string): string[] {
  const dir = join(home, '.claude', 'hooks')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return [...new Set(names.flatMap((name) => regularTarget(join(dir, name)) ?? []))]
}
