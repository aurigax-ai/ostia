/**
 * Session → workDir registry, fed by the `session-added`/`session-closed` lifecycle
 * events (`lifecycle:event` in `src/main/index.ts`). Main-side services (wiki/kanban/
 * vault/process) key off the caller's paneId/sessionId but need the project root to
 * scope their reads/writes; this is how they get it.
 *
 * Pure module — no Electron import — so every project-scoped service (`processManager.ts`,
 * `vault.ts`, ...) can depend on it directly instead of importing `index.ts`, which used
 * to create an import cycle (`index.ts` → `processManager.ts` → `index.ts`).
 */
const sessionWorkDirs = new Map<string, string>()

/** Record (or update) the project root for a session, from the `session-added` event. */
export function setSessionWorkDir(sessionId: string, workDir: string): void {
  sessionWorkDirs.set(sessionId, workDir)
}

/** Forget a session's workDir, from the `session-closed` event. */
export function removeSession(sessionId: string): void {
  sessionWorkDirs.delete(sessionId)
}

/** The project workDir for a session, if known. */
export function workDirForSession(sessionId?: string): string | undefined {
  return sessionId ? sessionWorkDirs.get(sessionId) : undefined
}
