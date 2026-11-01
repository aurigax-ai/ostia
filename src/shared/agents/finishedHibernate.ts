export const DEFAULT_FINISHED_HIBERNATE_MINUTES = 10

const FINISHED_HIBERNATE_MINUTES_MAX = 1440

export function finishedHibernateMinutes(raw: unknown): number {
  const n = Number(raw)
  if (raw === undefined || raw === null || !Number.isFinite(n)) {
    return DEFAULT_FINISHED_HIBERNATE_MINUTES
  }
  return Math.min(FINISHED_HIBERNATE_MINUTES_MAX, Math.max(0, Math.round(n)))
}
