const sessionWorkDirs = new Map<string, string>()

export function setSessionWorkDir(sessionId: string, workDir: string): void {
  sessionWorkDirs.set(sessionId, workDir)
}

export function removeSession(sessionId: string): void {
  sessionWorkDirs.delete(sessionId)
}

export function workDirForSession(sessionId?: string): string | undefined {
  return sessionId ? sessionWorkDirs.get(sessionId) : undefined
}
