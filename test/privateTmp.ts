import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
const prefix = process.platform === 'darwin' ? 'pv-' : 'ostia-vitest-'
const root = realpathSync(mkdtempSync(join(base, prefix)))
process.env.TMPDIR = root
if (process.platform === 'darwin') process.env.XDG_DATA_HOME = join(root, 'data')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
