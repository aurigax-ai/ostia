import { homedir } from 'node:os'
import { app } from 'electron'
import { type Dict, fmt } from '../../shared/app/dict'
import { postNotification } from '../attention/notify'
import type { NotifyWiring } from '../attention/notifyWiring'
import type { AppLog } from '../diagnostics/appLog'
import type { ProtectedFolder } from './folderAccess'
import { createFolderAccessWatch, PERIODIC_PROBE_MS } from './folderAccessWatch'
import {
  hasFullDiskAccess,
  readFoldersInKeptShells,
  readFoldersInMain,
  sweepKeptProbes,
} from './folderProbe'
import { keptShellsDir } from './keptPaths'
import type { KeptShells } from './keptShells'

interface FolderAccessWiringDeps {
  keptShells: KeptShells
  mainStrings: () => Dict
  notifyDeps: NotifyWiring['notifyDeps']
  services: { appLog: AppLog | null }
}

export function startFolderAccessWatch({
  keptShells,
  mainStrings,
  notifyDeps,
  services,
}: FolderAccessWiringDeps): void {
  if (process.platform !== 'darwin') return
  const home = homedir()
  const dir = keptShellsDir(app.getPath('userData'))
  const swept = sweepKeptProbes(dir)
  const watch = createFolderAccessWatch({
    now: Date.now,
    hasFullDiskAccess: () => hasFullDiskAccess(),
    readMain: () => readFoldersInMain(home),
    readKept: async () => {
      await swept
      return readFoldersInKeptShells({
        dir,
        home,
        runShell: (script) => keptShells.runShell(script),
      })
    },
    announce: (folders: ProtectedFolder[]) => {
      services.appLog?.warn('folder-access-blocked', { folders: folders.join(',') })
      const text = mainStrings().native.folderAccessBlocked
      postNotification(notifyDeps, {
        title: fmt(text.title, { folders: folders.map((f) => `~/${f}`).join(', ') }),
        body: text.body,
        from: 'kept-shells',
        evenWhenFocused: true,
      })
    },
  })
  void keptShells.ready.then(() => {
    if (keptShells.reattachedFromOtherOwner()) void watch.probe()
  })
  app.on('browser-window-focus', () => void watch.focused())
  setInterval(() => void watch.probe(), PERIODIC_PROBE_MS).unref()
}
