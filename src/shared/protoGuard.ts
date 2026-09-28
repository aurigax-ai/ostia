const DANGEROUS_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

export function isDangerousSegment(segment: string): boolean {
  return DANGEROUS_SEGMENTS.has(segment)
}

export function hasDangerousSegment(path: string): boolean {
  return path.split('.').some(isDangerousSegment)
}
