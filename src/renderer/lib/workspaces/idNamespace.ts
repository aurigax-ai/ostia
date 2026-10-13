let namespace = ''

export function setIdNamespace(next: string): void {
  namespace = next
}

export function namespacedId(prefix: string, n: number, separator = '-'): string {
  return namespace ? `${prefix}${separator}${namespace}-${n}` : `${prefix}${separator}${n}`
}
