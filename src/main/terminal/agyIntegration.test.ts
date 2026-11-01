import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agyHooksJson, agyPluginDigest, installAgyPlugin } from './agyIntegration'

const FAKE_AGY = join(process.cwd(), 'test/fixtures/tools/bin/agy')

let dir: string
let config: string
let log: string
let cli: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-plugin-'))
  config = join(dir, 'config')
  log = join(dir, 'calls.log')
  cli = join(dir, 'cli.js')
  writeFileSync(
    cli,
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin: require('node:fs').readFileSync(0, 'utf8') }) + '\\n')\n`,
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function pluginDir(): string {
  const [name] = readdirSync(join(config, 'plugins')).filter((entry) => entry.startsWith('ostia-'))
  return join(config, 'plugins', name)
}

function fire(event: string, payload: object, env: Record<string, string>): string {
  const res = spawnSync(
    FAKE_AGY,
    [join(pluginDir(), 'hooks.json'), event, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', OSTIA_NODE: process.execPath, OSTIA_CLI: cli, ...env },
    },
  )
  return res.stdout
}

function calls(): { args: string[]; stdin: string }[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []
}

describe('installAgyPlugin', () => {
  it('writes nothing when agy has no config folder', () => {
    expect(installAgyPlugin(config)).toBeNull()
    expect(existsSync(config)).toBe(false)
  })

  it('installs one generation under agy’s plugins folder and leaves other plugins alone', () => {
    mkdirSync(join(config, 'plugins', 'mine'), { recursive: true })
    writeFileSync(join(config, 'plugins', 'mine', 'plugin.json'), '{}')
    const installed = installAgyPlugin(config)
    expect(installed).toBe(join(config, 'plugins', `ostia-${agyPluginDigest()}`))
    expect(JSON.parse(readFileSync(join(pluginDir(), 'plugin.json'), 'utf8'))).toMatchObject({
      name: 'ostia',
    })
    expect(readFileSync(join(pluginDir(), 'hooks.json'), 'utf8')).toBe(agyHooksJson())
    expect(existsSync(join(config, 'plugins', 'mine', 'plugin.json'))).toBe(true)
  })

  it('never rewrites a generation in place and removes an older one', () => {
    mkdirSync(join(config, 'plugins', 'ostia-0000000000000000'), { recursive: true })
    writeFileSync(join(config, 'plugins', 'ostia-0000000000000000', 'hooks.json'), '{}')
    const first = installAgyPlugin(config)
    writeFileSync(join(pluginDir(), 'hooks.json'), 'edited')
    expect(installAgyPlugin(config)).toBe(first)
    expect(readFileSync(join(pluginDir(), 'hooks.json'), 'utf8')).toBe('edited')
    expect(existsSync(join(config, 'plugins', 'ostia-0000000000000000', 'hooks.json'))).toBe(true)
  })

  it('lists the hook events agy runs', () => {
    expect(Object.keys(JSON.parse(agyHooksJson()).ostia)).toEqual([
      'SessionStart',
      'PreInvocation',
      'Stop',
    ])
  })
})

describe('the agy hooks', () => {
  const inPane = { OSTIA_SOCKET: '/tmp/s.sock' }
  const session = { conversationId: 'c-1', invocationNum: 0 }

  beforeEach(() => {
    mkdirSync(config, { recursive: true })
    installAgyPlugin(config)
  })

  it('SessionStart stores the conversation as the resume token', () => {
    expect(fire('SessionStart', session, inPane)).toBe('{}\n')
    expect(calls()).toEqual([
      { args: ['resume-token', 'agy', '-'], stdin: JSON.stringify(session) },
    ])
  })

  it('PreInvocation stores the token and reports working', () => {
    expect(fire('PreInvocation', session, inPane)).toBe('{}\n{}\n')
    expect(calls().map((call) => call.args)).toEqual([
      ['resume-token', 'agy', '-'],
      ['state', 'working'],
    ])
  })

  it('Stop reports done and closes the turn', () => {
    expect(fire('Stop', { conversationId: 'c-1' }, inPane)).toBe('{}\n')
    expect(calls()[0].args).toEqual(['state', 'done', '--stop'])
  })

  it('does nothing outside an Ostia pane but still answers agy with an empty object', () => {
    for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
      expect(fire(event, session, {}).split('\n').filter(Boolean)).toSatisfy((lines: string[]) =>
        lines.every((line) => line === '{}'),
      )
    }
    expect(calls()).toEqual([])
  })

  it('does nothing when agents.hooks.agy is off', () => {
    for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
      fire(event, session, { ...inPane, OSTIA_NO_AGY_HOOKS: '1' })
    }
    expect(calls()).toEqual([])
  })
})
