/**
 * Prototype-pollution guard shared by every user-supplied object key / dot-path / slug
 * across the toolbelt (settings dot-paths in `settingsStore.setByPath`, wiki slugs in
 * `wiki.set`, ...). Rejects the three property names — case-sensitive — that let a
 * crafted key walk off a plain object onto `Object.prototype` (or a constructor
 * function) and pollute every object in the process:
 *
 *   - `__proto__`   — reassigns an object's own [[Prototype]] via the accessor
 *                      `Object.prototype.__proto__`; `obj.__proto__.x = 1` reaches
 *                      `Object.prototype` directly.
 *   - `constructor` — `obj.constructor.prototype.x = 1` reaches `Object.prototype` for
 *                      any plain object, since `({}).constructor === Object`.
 *   - `prototype`   — the second half of the `constructor.prototype` vector above.
 *
 * Blocking a bare segment (not just the last one) matters because both real attacks are
 * multi-segment (`constructor.prototype.polluted`, `__proto__.polluted`) — checking only
 * the leaf key would miss them.
 */

const DANGEROUS_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

/** True iff `segment` is exactly (case-sensitive) one of the reserved property names. */
export function isDangerousSegment(segment: string): boolean {
  return DANGEROUS_SEGMENTS.has(segment)
}

/**
 * True iff `path` — a dot-separated path (`appearance.terminal.size`) or a single flat
 * key/slug with no dots at all — contains a dangerous segment anywhere in it.
 */
export function hasDangerousSegment(path: string): boolean {
  return path.split('.').some(isDangerousSegment)
}
