import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranslator } from '@aurigax-ai/ostia-extension-sdk'
import { HUMAN_ACTOR } from './trellis'

const FIXTURES = join(__dirname, '../../../test/fixtures/tools')

export const translate = createTranslator(__dirname)

export interface FakeTrellis {
  root: string
  dir: string
  home: string
  calls: () => string[]
  state: () => {
    board: { columns: { name: string; cards: { ref: string; claimed_by?: string }[] }[] }
    comments: Record<string, { actor: string; body: string }[]>
  }
  restore: () => void
}

export function fakeTrellis(): FakeTrellis {
  const root = mkdtempSync(join(tmpdir(), 'pine-trellis-fake-'))
  const dir = join(root, 'fake')
  const home = join(root, 'home')
  mkdirSync(dir)
  mkdirSync(home)
  for (const f of readdirSync(join(FIXTURES, 'trellis'))) {
    copyFileSync(join(FIXTURES, 'trellis', f), join(dir, f))
  }
  const saved = {
    path: process.env.PATH,
    agent: process.env.TRELLIS_AGENT,
  }
  process.env.PATH = `${join(FIXTURES, 'bin')}:${saved.path}`
  process.env.FAKE_TRELLIS_DIR = dir
  process.env.TRELLIS_AGENT = HUMAN_ACTOR
  return {
    root,
    dir,
    home,
    calls: () => {
      const log = join(dir, 'calls.log')
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    },
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    restore: () => {
      process.env.PATH = saved.path
      Reflect.deleteProperty(process.env, 'FAKE_TRELLIS_DIR')
      if (saved.agent === undefined) Reflect.deleteProperty(process.env, 'TRELLIS_AGENT')
      else process.env.TRELLIS_AGENT = saved.agent
      rmSync(root, { recursive: true, force: true })
    },
  }
}
