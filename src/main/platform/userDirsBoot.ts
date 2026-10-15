import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'

if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = join(app.getPath('appData'), PRODUCT_NAME)
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}
