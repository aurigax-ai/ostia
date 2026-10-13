import './platform/userDirsBoot'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { parseDiscreteGpu } from '../shared/app/discreteGpu'
import { readEnv } from '../shared/appEnv'
import { registerPreviewScheme } from './artifacts/previewScheme'
import { keepTestCrashDumps } from './diagnostics/testCrashDumps'
import { discreteGpu, gpuStartPlan, readSwitcherooGpus } from './platform/discreteGpu'
import { offerOldDirsMove } from './platform/oldDirsPrompt'
import {
  OLD_PRODUCT_NAME,
  appDataDir,
  dataHome,
  oldDirMoves,
  projectDirMoves,
  savedWorkspaceFolders,
} from './platform/userDirs'

const ANSWERS: Readonly<Record<string, number>> = { move: 0, later: 1 }

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
    app.relaunch()
    app.exit(0)
    return true
  }
  if (plan.renderNode) app.commandLine.appendSwitch('render-node-override', plan.renderNode)
  return false
}

async function start(): Promise<void> {
  if (relaunchedOnDiscreteGpu()) return
  registerPreviewScheme()
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
