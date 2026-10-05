import './userDirsBoot'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { readEnv } from '../shared/appEnv'
import { offerOldDirsMove } from './oldDirsPrompt'
import {
  OLD_PRODUCT_NAME,
  appDataDir,
  dataHome,
  oldDirMoves,
  projectDirMoves,
  savedWorkspaceFolders,
} from './userDirs'

const ANSWERS: Readonly<Record<string, number>> = { move: 0, later: 1 }

function presetAnswer(): number | undefined {
  if (app.isPackaged) return undefined
  return ANSWERS[readEnv('E2E_OLD_DIRS') ?? '']
}

async function start(): Promise<void> {
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

if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0)
else void start()
