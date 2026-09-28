const DANGEROUS_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

export function isDangerousSegment(segment: string): boolean {
  return DANGEROUS_SEGMENTS.has(segment)
}
