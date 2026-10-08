import { type JsonObject, isObject } from './profile'

export type Side = 'local' | 'remote'

export interface MergeConflict<T> {
  key: string
  local: T | undefined
  remote: T | undefined
  winner: Side
}

export interface Merged<T> {
  merged: Map<string, T>
  conflicts: MergeConflict<T>[]
}

export function mergeMaps<T>(
  base: ReadonlyMap<string, T> | null,
  local: ReadonlyMap<string, T>,
  remote: ReadonlyMap<string, T>,
  equal: (a: T | undefined, b: T | undefined) => boolean,
  winnerOf: (key: string, local: T | undefined, remote: T | undefined) => Side,
): Merged<T> {
  const merged = new Map<string, T>()
  const conflicts: MergeConflict<T>[] = []
  const keys = new Set([...(base?.keys() ?? []), ...local.keys(), ...remote.keys()])
  for (const key of [...keys].sort()) {
    const l = local.get(key)
    const r = remote.get(key)
    let take: T | undefined
    if (equal(l, r)) take = l
    else if (base === null && l === undefined) take = r
    else if (base === null && r === undefined) take = l
    else if (base !== null && equal(l, base.get(key))) take = r
    else if (base !== null && equal(r, base.get(key))) take = l
    else {
      const winner = winnerOf(key, l, r)
      conflicts.push({ key, local: l, remote: r, winner })
      take = winner === 'local' ? l : r
    }
    if (take !== undefined) merged.set(key, take)
  }
  return { merged, conflicts }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const sameJson = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b)

export const pathKey = (path: readonly string[]): string => JSON.stringify(path)

export const keyPath = (key: string): string[] => JSON.parse(key) as string[]

export function flatten(value: JsonObject | null): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const walk = (node: JsonObject, path: string[]): void => {
    for (const [key, inner] of Object.entries(node)) {
      const at = [...path, key]
      if (isObject(inner) && Object.keys(inner).length > 0) walk(inner, at)
      else out.set(pathKey(at), inner)
    }
  }
  if (value) walk(value, [])
  return out
}

export function unflatten(leaves: ReadonlyMap<string, unknown>): JsonObject {
  const root: JsonObject = {}
  const entries = [...leaves].map(([key, value]) => ({ path: keyPath(key), value }))
  entries.sort((a, b) => a.path.length - b.path.length)
  for (const { path, value } of entries) {
    let cursor = root
    for (const segment of path.slice(0, -1)) {
      if (!isObject(cursor[segment])) cursor[segment] = {}
      cursor = cursor[segment] as JsonObject
    }
    cursor[path[path.length - 1]] = structuredClone(value)
  }
  return root
}

export function withValueAt(value: JsonObject, path: readonly string[], next: unknown): JsonObject {
  const leaves = flatten(value)
  const prefix = pathKey(path).slice(0, -1)
  for (const key of [...leaves.keys()]) {
    if (key === pathKey(path) || key.startsWith(`${prefix},`)) leaves.delete(key)
  }
  if (next !== undefined) leaves.set(pathKey(path), next)
  return unflatten(leaves)
}
