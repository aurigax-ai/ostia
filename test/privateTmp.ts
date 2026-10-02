import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-vitest-')))
process.env.TMPDIR = root

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
