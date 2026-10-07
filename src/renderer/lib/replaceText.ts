import type { ReplaceProgress, ReplaceState } from '@shared/installMethod'
import type { Dict } from '../i18n/dict'
import { fmt } from '../i18n/useDict'

const MIB = 1024 * 1024

export function replaceLabel(
  d: Dict,
  state: ReplaceState,
  progress: ReplaceProgress | null,
): string {
  if (state.status === 'installing') return d.update.installing
  if (!progress || progress.total <= 0) return d.update.downloading
  const percent = Math.min(100, Math.floor((progress.received / progress.total) * 100))
  return fmt(d.update.downloadingPercent, {
    percent,
    received: Math.round(progress.received / MIB),
    total: Math.round(progress.total / MIB),
  })
}
