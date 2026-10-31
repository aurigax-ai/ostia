const replaced = new Set<string>()

export function noteReplacedShell(paneId: string): void {
  replaced.add(paneId)
}

export function hasReplacedShell(paneId: string): boolean {
  return replaced.has(paneId)
}

export function resetReplacedShells(): void {
  replaced.clear()
}
