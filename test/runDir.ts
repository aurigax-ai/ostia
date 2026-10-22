import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll } from 'vitest'

if (process.platform === 'darwin') {
  const dataHome = realpathSync(mkdtempSync(join('/tmp', 'pd-')))
  process.env.XDG_DATA_HOME = dataHome
  afterAll(() => {
    rmSync(dataHome, { recursive: true, force: true })
  })
}
