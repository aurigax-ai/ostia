import { type PendingSweep, sweepOldInstall } from './installReplace'
import { discardStaged } from './macReplace'

export interface LaunchSweep {
  pending: PendingSweep | null
  appDir: string | null
  version: string
  macInstall: boolean
  swept: () => void
  warn: (event: 'install-sweep-failed' | 'update-staged-discard-failed') => void
}

export async function sweepUpdateLeftovers(sweep: LaunchSweep): Promise<void> {
  const old = sweepOldInstall(sweep.pending, sweep.appDir, sweep.version).then(
    (swept) => {
      if (swept) sweep.swept()
    },
    () => sweep.warn('install-sweep-failed'),
  )
  const { appDir } = sweep
  const staged =
    sweep.macInstall && appDir
      ? discardStaged(appDir).catch(() => sweep.warn('update-staged-discard-failed'))
      : undefined
  await Promise.all([old, staged])
}
