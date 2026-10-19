import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranslator } from '@aurigax-ai/ostia-extension-sdk'

const FIXTURE_BIN = join(__dirname, '../../../test/fixtures/tools/bin')

export const translate = createTranslator(__dirname)

interface FakeScreen {
  id: string
  label: string
  allow: string[]
  owner: string
  agentToken: string
  viewerToken: string
  log?: { time: string; verb: string }[]
}

export interface FakeScreens {
  dir: string
  calls: () => string[]
  screens: () => FakeScreen[]
  emit: (id: string, event: Record<string, unknown>) => void
  phoneCall: (id: string, call: Record<string, unknown>) => void
  phoneReplies: (id: string) => Record<string, unknown>[]
  restore: () => void
}

export function fakeScreens(opts: { onPath?: boolean; version?: string } = {}): FakeScreens {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-screens-fake-'))
  const saved = {
    path: process.env.PATH,
    token: process.env.SCREENS_TOKEN,
    runtime: process.env.XDG_RUNTIME_DIR,
  }
  process.env.PATH =
    opts.onPath === false ? join(dir, 'empty-bin') : `${FIXTURE_BIN}:${saved.path ?? ''}`
  process.env.FAKE_SCREENS_DIR = dir
  process.env.XDG_RUNTIME_DIR = join(dir, 'run')
  if (opts.version) process.env.FAKE_SCREENS_VERSION = opts.version
  else Reflect.deleteProperty(process.env, 'FAKE_SCREENS_VERSION')
  Reflect.deleteProperty(process.env, 'SCREENS_TOKEN')
  const stateFile = join(dir, 'state.json')
  return {
    dir,
    calls: () => {
      const log = join(dir, 'calls.log')
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    },
    screens: () =>
      existsSync(stateFile)
        ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { screens: FakeScreen[] }).screens
        : [],
    emit: (id, event) =>
      appendFileSync(join(dir, `events-${id}.jsonl`), `${JSON.stringify(event)}\n`),
    phoneCall: (id, call) =>
      appendFileSync(join(dir, `phone-calls-${id}.jsonl`), `${JSON.stringify(call)}\n`),
    phoneReplies: (id) => {
      const file = join(dir, `phone-replies-${id}.jsonl`)
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    },
    restore: () => {
      process.env.PATH = saved.path
      Reflect.deleteProperty(process.env, 'FAKE_SCREENS_DIR')
      Reflect.deleteProperty(process.env, 'FAKE_SCREENS_VERSION')
      if (saved.token !== undefined) process.env.SCREENS_TOKEN = saved.token
      if (saved.runtime === undefined) Reflect.deleteProperty(process.env, 'XDG_RUNTIME_DIR')
      else process.env.XDG_RUNTIME_DIR = saved.runtime
      const pid = join(dir, 'daemon.pid')
      if (existsSync(pid)) {
        try {
          process.kill(Number(readFileSync(pid, 'utf8')), 'SIGKILL')
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    },
  }
}
