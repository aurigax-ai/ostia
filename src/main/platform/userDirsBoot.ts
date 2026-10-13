import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { PRODUCT_NAME } from '../../shared/product'

if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = join(app.getPath('appData'), PRODUCT_NAME)
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}
