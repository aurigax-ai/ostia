import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ALLOW_FILE = 'i18n-allow.json'

function keyMatches(pattern, key) {
  const want = pattern.split('.')
  const have = key.split('.')
  return want.length === have.length && want.every((part, i) => part === '*' || part === have[i])
}

function entries(groups, section) {
  return Object.entries(groups ?? {}).flatMap(([reason, patterns]) =>
    patterns.map((pattern) => ({ section, reason, pattern, hits: 0 })),
  )
}

export function loadAllow(root) {
  const raw = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'))
  const same = Object.fromEntries(
    Object.entries(raw.same ?? {}).map(([scope, groups]) => [scope, entries(groups, `same.${scope}`)]),
  )
  const unused = entries(raw.unused, 'unused')
  const text = entries(raw.literals?.text, 'literals.text')
  const hit = (list, test) => {
    const found = list.find((entry) => test(entry.pattern))
    if (found) found.hits++
    return found
  }
  return {
    same: (scope, key) => hit(same[scope] ?? [], (p) => keyMatches(p, key)),
    unused: (key) => hit(unused, (p) => keyMatches(p, key)),
    literalText: (value) => hit(text, (p) => p === value),
    stale: () =>
      [...Object.values(same).flat(), ...unused, ...text]
        .filter((entry) => entry.hits === 0)
        .map(
          (entry) =>
            `stale: ${ALLOW_FILE} ${entry.section} "${entry.reason}": ${JSON.stringify(entry.pattern)} matches nothing. Remove it.`,
        ),
  }
}
