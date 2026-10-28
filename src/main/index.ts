import './platform/userDirsBoot'
import './platform/compileCacheBoot'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { app, dialog } from 'electron'
import { parseDiscreteGpu } from '../shared/app/discreteGpu'
import { registerPreviewScheme } from './artifacts/previewScheme'
import { keepTestCrashDumps } from './diagnostics/testCrashDumps'
import { VIEWER_SCHEME_PRIVILEGES } from './files/viewers/viewerScheme'
import { discreteGpu, gpuStartPlan, readSwitcherooGpus } from './platform/discreteGpu'
import { readNoNewPrivs } from './platform/noNewPrivs'
import { relaunchWithoutNoNewPrivs } from './platform/noNewPrivsRelaunch'
import { offerOldDirsMove } from './platform/oldDirsPrompt'
import { launchSelf, relaunchApp } from './platform/relaunch'
import {
  appDataDir,
  dataHome,
  OLD_PRODUCT_NAME,
  oldDirMoves,
  projectDirMoves,
  savedWorkspaceFolders,
} from './platform/userDirs'

const ANSWERS: Readonly<Record<string, number>> = { move: 0 }

function presetAnswer(): number | undefined {
  if (app.isPackaged) return undefined
  return ANSWERS[readEnv('E2E_OLD_DIRS') ?? '']
}

function discreteGpuSetting(): boolean {
  try {
    const settings = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
    )
    return parseDiscreteGpu(settings?.behavior?.discreteGpu)
  } catch {
    return false
  }
}

function relaunchedOnDiscreteGpu(): boolean {
  if (process.platform !== 'linux' || !discreteGpuSetting()) return false
  const gpu = discreteGpu(readSwitcherooGpus())
  if (!gpu) return false
  const plan = gpuStartPlan(process.env, gpu)
  if (plan.kind === 'relaunch') {
    Object.assign(process.env, plan.env)
    relaunchApp()
    app.exit(0)
    return true
  }
  if (plan.renderNode) app.commandLine.appendSwitch('render-node-override', plan.renderNode)
  return false
}

function relaunchedWithoutNoNewPrivs(): boolean {
  const relaunched = relaunchWithoutNoNewPrivs({
    noNewPrivs: readNoNewPrivs(),
    env: process.env,
    launch: launchSelf,
    warn: (line) => console.error(line),
  })
  if (relaunched) app.exit(0)
  return relaunched
}

async function start(): Promise<void> {
  if (relaunchedWithoutNoNewPrivs() || relaunchedOnDiscreteGpu()) return
  registerPreviewScheme([VIEWER_SCHEME_PRIVILEGES])
  await app.whenReady()
  const preset = presetAnswer()
  const folders = savedWorkspaceFolders([
    join(dataHome(), OLD_PRODUCT_NAME, 'workspaces.json'),
    join(appDataDir(), 'workspaces.json'),
  ])
  await offerOldDirsMove({
    moves: [
      ...oldDirMoves(app.getPath('appData'), app.commandLine.hasSwitch('user-data-dir')),
      ...projectDirMoves(folders),
    ],
    ask: async (options) => preset ?? (await dialog.showMessageBox(options)).response,
    locale: app.getLocale(),
    log: (line) => console.error(line),
  })
  await import('./app')
}

keepTestCrashDumps()

if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0)
else void start()
