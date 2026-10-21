import { app } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { isMacInstall, replacesInApp } from '../../shared/app/installMethod'
import type { CommandBridge } from '../control/commandBridge'
import type { AppLog } from '../diagnostics/appLog'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import { readSettingsFile } from '../platform/settingsFile'
import type { HostPaneGrants } from '../sandbox/hostPanes'
import type { AppQuit } from '../windows/appQuit'
import { registerAppUpdate } from './appUpdate'
import { appVersion } from './appVersion'
import { installAppDir, installMethod } from './installMethod'
import {
  canReplaceInstall,
  createInstallReplacer,
  type PendingSweep,
  releaseDownloadBase,
  runTar,
  tarballReplace,
} from './installReplace'
import { sweepUpdateLeftovers } from './launchSweep'
import type { SignaturePolicy } from './macReplace'
import { canReplaceBundle, macReplace, runCommand } from './macReplace'
import { readUpdateChannel, registerReleaseCheck } from './releaseCheck'
import { createUpdateRunner, type UpdateRunner } from './updateRun'

interface UpdateStartDeps {
  quit: {
    restartRequested: boolean
    stagedUpdate: { pending: PendingSweep; sweepFile: string } | null
  }
  requestQuit: AppQuit['requestQuit']
  services: {
    appLog: AppLog | null
    releaseChecks: { settingsChanged: () => void } | null
    updateRunner: UpdateRunner | null
  }
  mainStrings: () => Dict
  openTerminalInWindow: CommandBridge['openTerminalInWindow']
  hostPaneGrants: HostPaneGrants
  UPDATE_HOST_GRANT_ID: string
  openExternalSafe: (url: string) => boolean
  updatePolicy: SignaturePolicy
  broadcast: (channel: string, payload: unknown) => void
}

export function startUpdates({
  quit,
  requestQuit,
  services,
  mainStrings,
  openTerminalInWindow,
  hostPaneGrants,
  UPDATE_HOST_GRANT_ID,
  openExternalSafe,
  updatePolicy,
  broadcast,
}: UpdateStartDeps) {
  registerAppUpdate(() => {
    quit.restartRequested = true
    requestQuit()
  }, broadcast)
  services.updateRunner = createUpdateRunner({
    method: installMethod,
    title: () => mainStrings().native.updateTitle,
    openTerminal: (req) => openTerminalInWindow(req),
    hostToken: (command) => {
      hostPaneGrants.offer(UPDATE_HOST_GRANT_ID, command)
      return hostPaneGrants.claim(UPDATE_HOST_GRANT_ID, command) ?? ''
    },
    onChange: (state) => broadcast('app:update-run-state', state),
  })
  const sweepFile = storePath('install-replace', 'global')
  const macInstall = isMacInstall(installMethod())
  void sweepUpdateLeftovers({
    pending: loadJson<PendingSweep | null>(sweepFile, null),
    appDir: installAppDir(),
    version: appVersion(),
    macInstall,
    swept: () => saveJson(sweepFile, null),
    warn: (event) => services.appLog?.warn(event),
  })
  const updateDir = (): string | null =>
    replacesInApp(installMethod(), readUpdateChannel(readSettingsFile())) ? installAppDir() : null
  const downloadBase = releaseDownloadBase(app.isPackaged, process.env)
  services.releaseChecks = registerReleaseCheck({
    openExternal: openExternalSafe,
    readSettings: readSettingsFile,
    log: services.appLog,
    version: appVersion(),
    method: installMethod,
    updateRunner: services.updateRunner,
    replaceAvailability: async () => {
      const dir = updateDir()
      if (!dir) return null
      return macInstall ? canReplaceBundle(dir) : canReplaceInstall(dir)
    },
    broadcast,
    replacer: createInstallReplacer({
      appDir: updateDir,
      replace: macInstall
        ? macReplace({
            base: downloadBase,
            fetch,
            run: runCommand,
            policy: updatePolicy,
          })
        : tarballReplace({ base: downloadBase, fetch, tar: runTar }),
      onState: (state) => broadcast('app:install-replace-state', state),
      onProgress: (progress) => broadcast('app:update-progress', progress),
      onReplaced: (pending) => {
        if (macInstall) quit.stagedUpdate = { pending, sweepFile }
        else saveJson(sweepFile, pending)
      },
    }),
  })
}
