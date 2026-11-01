export function startWindowCoverReport(): () => void {
  const report = (): void => window.ostia.pty.cover(document.visibilityState === 'hidden')
  document.addEventListener('visibilitychange', report)
  report()
  return () => document.removeEventListener('visibilitychange', report)
}
