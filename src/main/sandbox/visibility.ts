import { delimiter } from 'node:path'

export interface SandboxReadRules {
  denyRead: readonly string[]
  allowRead: readonly string[]
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)
}

function deepest(path: string, dirs: readonly string[]): number {
  let longest = -1
  for (const dir of dirs) if (within(path, dir)) longest = Math.max(longest, dir.length)
  return longest
}

export function visibleInSandbox(path: string, rules: SandboxReadRules): boolean {
  const denied = deepest(path, rules.denyRead)
  return denied < 0 || deepest(path, rules.allowRead) > denied
}

export function leadsIntoSandbox(path: string, rules: SandboxReadRules): boolean {
  return rules.allowRead.some(
    (allowed) => within(allowed, path) && visibleInSandbox(allowed, rules),
  )
}

export function sandboxPath(path: string, rules: SandboxReadRules): string {
  return path
    .split(delimiter)
    .filter((dir) => dir !== '' && visibleInSandbox(dir, rules))
    .join(delimiter)
}

export function sandboxEntries<T extends { name: string }>(
  dir: string,
  entries: readonly T[],
  rules: SandboxReadRules,
): T[] {
  const base = dir.endsWith('/') ? dir : `${dir}/`
  return entries.filter((entry) => {
    const path = `${base}${entry.name}`
    return visibleInSandbox(path, rules) || leadsIntoSandbox(path, rules)
  })
}
