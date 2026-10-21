import { join } from 'node:path'
import { languageForPath } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import { languageServerKey } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import { app, type BrowserWindow } from 'electron'
import { getByPaneId } from '../control/idRegistry'
import type { AppLog } from '../diagnostics/appLog'
import type { ExtensionContributions } from '../extensions/extensionContributions'
import { TreeWatches } from '../files/fileWatch'
import type { OpenFileGrants } from '../files/openFileGrants'
import { resolveSafe } from '../platform/pathGuard'
import { programPath, registerRequirements } from '../platform/systemRequirements'
import { sandboxSpawnEnv } from '../sandbox/spawnEnv'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { releaseUserAgent } from '../updates/releaseCheck'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { LanguageServers } from './languageServers'
import { downloadBaseUrl, ManagedServers } from './managedServers'
import { ServerOverrides } from './serverOverrides'
import { scrubbedEnv } from './serverSpawn'

interface LanguageServerWiringDeps {
  contributions: () => ExtensionContributions | null
  fileRoots: () => string[]
  openFileGrants: OpenFileGrants
  workspaceSandboxes: WorkspaceSandboxes
  sandboxCanRead: (workspaceId: string, path: string) => boolean
  windows: Map<string, BrowserWindow>
  broadcast: (channel: string, payload: unknown) => void
  appLog: () => AppLog | null
}

export function createLanguageServerWiring({
  contributions,
  fileRoots,
  openFileGrants,
  workspaceSandboxes,
  sandboxCanRead,
  windows,
  broadcast,
  appLog,
}: LanguageServerWiringDeps) {
  function editorLanguageOf(path: string): string {
    return languageForPath(
      path,
      (contributions()?.editorLanguages() ?? []).map((source) => source.language),
    )
  }

  const managedServers = new ManagedServers({
    dir: join(app.getPath('userData'), 'language-servers'),
    userAgent: releaseUserAgent(app.getVersion()),
    findProgram: (program) => programPath(program),
    env: () => scrubbedEnv(process.env),
    baseUrl: downloadBaseUrl(app.isPackaged, process.env),
  })

  const LANGUAGE_SERVER_WATCH_DEBOUNCE_MS = 300
  const languageServerWatches = new TreeWatches({
    confine: (dir) => resolveSafe(dir, fileRoots()),
    debounceMs: LANGUAGE_SERVER_WATCH_DEBOUNCE_MS,
  })

  const serverOverrides = new ServerOverrides(
    join(app.getPath('userData'), 'language-server-programs.json'),
  )

  function createLanguageServers(): LanguageServers {
    return new LanguageServers({
      watchTree: (root, onChange) => languageServerWatches.watch(root, onChange),
      sources: () =>
        (contributions()?.languageServers() ?? []).map((source) => {
          const override = serverOverrides.get(languageServerKey(source.extId, source.server.id))
          return override ? { ...source, override } : source
        }),
      nodePath: process.execPath,
      env: () => process.env,
      pane: (paneId) => getByPaneId(paneId),
      confine: (path) => openFileGrants.confine(path),
      workDir: (workspaceId) => workDirForWorkspace(workspaceId),
      roots: fileRoots,
      sandbox: {
        owner: (workspaceId) =>
          workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
            ? workspaceSandboxes.owner(workspaceId)
            : null,
        readable: sandboxCanRead,
        wrap: (workspaceId, command, extraReads) =>
          workspaceSandboxes.wrap(workspaceId, command, 'bash', [], extraReads),
        env: (workspaceId, env) => ({
          ...sandboxSpawnEnv(env as Record<string, string>),
          TMPDIR: workspaceSandboxes.tmp.tmpDir(workspaceId),
        }),
      },
      findProgram: (program) => programPath(program),
      languageOf: editorLanguageOf,
      managed: managedServers,
      registerRequirements,
      post: (windowId, channel, ...args) => {
        const win = windows.get(windowId)
        if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
      },
      changed: (list) => broadcast('lsp:servers-changed', list),
      log: (event, fields) => appLog()?.info(event, fields),
    })
  }

  return {
    editorLanguageOf,
    managedServers,
    languageServerWatches,
    serverOverrides,
    createLanguageServers,
  }
}
