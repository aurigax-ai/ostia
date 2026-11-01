import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { MANAGER_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import type { IPty } from 'node-pty'
import type { AgentResume } from '../../shared/agents/agentResume'
import { setCaps } from '../approvals/capabilityStore'
import { controlSocketPath } from '../control/controlServer'
import { getByPaneId, markManager, registerPane } from '../control/idRegistry'
import { privateTmpDir } from '../platform/privateTmp'
import { managerSettings } from '../platform/settingsFile'
import type { PtyRegistry } from '../terminal/pty/ptyRegistry'
import { shellStateDir } from '../terminal/shellStateDir'
import { spawnFolder } from '../terminal/spawnCwd'
import {
  PTY_COLOR_ENV,
  PTY_TERM_NAME,
  ptyHyperlinkEnv,
  ptyIdentityEnv,
  ptyLocaleEnv,
} from '../terminal/terminalType'
import type { WindowSend } from '../windows/windowSend'
import { managerArgv, writeManagerClaudePlugin, writeManagerCodexContext } from './managerAgent'

interface ManagerPtyDeps {
  loadPty: PtyRegistry['loadPty']
  primaryWindowId: WindowSend['primaryWindowId']
  trackPty: PtyRegistry['trackPty']
  feedPty: PtyRegistry['feedPty']
}

export type ManagerPty = ReturnType<typeof createManagerPty>

export function createManagerPty({ loadPty, primaryWindowId, trackPty, feedPty }: ManagerPtyDeps) {
  function paneEnv(paneId: string, windowId: string, cwd: string): Record<string, string> {
    const identity = registerPane({ windowId, workspaceId: '', paneId })
    return appEnv({
      PANE_ID: identity.externalId,
      TOKEN: identity.token,
      START_DIR: cwd,
      SOCKET: controlSocketPath(),
      CLI: join(app.getAppPath(), 'out/cli/index.js'),
      NODE: process.execPath,
    })
  }

  function managerLaunchArgv(argv: string[], resume: AgentResume | null): string[] {
    const { skills } = managerSettings()
    const base = privateTmpDir(`${PRODUCT_NAME}-manager`)
    const claudePluginDir = join(base, 'claude-plugin')
    writeManagerClaudePlugin(claudePluginDir, skills)
    const codexContextFile = writeManagerCodexContext(join(base, 'codex'), skills)
    return managerArgv(argv, { claudePluginDir, codexContextFile, resume })
  }

  function spawnManagerPty(req: {
    paneId: string
    argv: string[]
    cwd: string
    cols: number
    rows: number
    path?: string
    resume: AgentResume | null
    onExit: () => void
  }): boolean {
    const mod = loadPty()
    const windowId = getByPaneId(req.paneId)?.windowId || primaryWindowId()
    const [file, ...args] = managerLaunchArgv(req.argv, req.resume)
    if (!mod || !windowId || !file) return false
    const { cwd } = spawnFolder(req.cwd)
    const env = {
      ...process.env,
      ...(req.path === undefined ? {} : { PATH: req.path }),
      ...paneEnv(req.paneId, windowId, cwd),
      ...ptyLocaleEnv(process.env, app.getLocale()),
      ...ptyHyperlinkEnv(process.env),
      ...PTY_COLOR_ENV,
      ...ptyIdentityEnv(app.getVersion()),
    } as Record<string, string>
    const identity = markManager(req.paneId)
    if (identity) setCaps(identity.externalId, MANAGER_CAPABILITIES)
    let pty: IPty
    try {
      pty = mod.spawn(file, args, {
        name: PTY_TERM_NAME,
        cols: req.cols,
        rows: req.rows,
        cwd,
        env,
      })
    } catch (err) {
      console.error('[manager] spawn failed', err)
      return false
    }
    const entry = trackPty(req.paneId, pty, {
      cols: req.cols,
      rows: req.rows,
      subs: new Map(),
      spawnPath: env.PATH ?? '',
      stateFile: join(shellStateDir(), randomUUID()),
      keepAlive: true,
    })
    entry.exitListeners.add(() => req.onExit())
    pty.onData((d) => feedPty(entry, d))
    pty.onExit(({ exitCode }) => entry.session.exit(exitCode))
    return true
  }

  return { spawnManagerPty }
}
