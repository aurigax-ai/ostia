export function relativePath(path: string, base: string): string | null {
  const root = base.endsWith('/') ? base : `${base}/`
  if (!path.startsWith(root) || path.length === root.length) return null
  return path.slice(root.length)
}

export function lineReference(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`
}
