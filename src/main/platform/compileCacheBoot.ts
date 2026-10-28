import { chmodSync, mkdirSync } from 'node:fs'
import { enableCompileCache, flushCompileCache } from 'node:module'
import { join } from 'node:path'
import { app } from 'electron'

const PRIVATE_FOLDER = 0o700

try {
  const folder = join(app.getPath('userData'), 'compile-cache')
  mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER })
  chmodSync(folder, PRIVATE_FOLDER)
  enableCompileCache(folder)
  app.once('browser-window-created', (_event, win) => win.once('ready-to-show', flushCompileCache))
} catch {}
