import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentPluginContent } from '../main/agentSkills'
import { registerControlServer, stopControlServer } from '../main/controlServer'
import { ExtensionHost, registerExtensionMethods } from '../main/extensionHost'
import { ExtensionStore } from '../main/extensionStore'
import { type PaneIdentity, registerPane } from '../main/idRegistry'
import {
  INTEGRATION_DIR,
  codexHookKey,
  codexHookTrustHash,
  extensionHookCommand,
  setAgentPlugins,
  shellIntegrationSpawnOptions,
} from '../main/shellIntegration'
import type { CommandResult } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')
const fixtures = join(repoRoot, 'test', 'fixtures', 'extensions-agent')

const FAKE_CLAUDE = `#!/usr/bin/env node
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const dir = args[args.indexOf('--plugin-dir') + 1]
for (const name of readdirSync(join(dir, 'skills')).sort()) {
  console.log('skill ' + name + ' ' + readdirSync(join(dir, 'skills', name)).sort().join(','))
}
const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks
const events = [
  ['SessionStart', { session_id: 's-1', hook_event_name: 'SessionStart' }],
  ['PreToolUse', { session_id: 's-1', hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
]
for (const [event, payload] of events) {
  for (const group of hooks[event] || []) {
    for (const hook of group.hooks) {
      if (!hook.command.includes(' agent-hook ')) continue
      const out = execFileSync('sh', ['-c', hook.command], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
      })
      console.log('hook ' + event + ' ' + out.trim())
    }
  }
}
`

const FAKE_CODEX = '#!/bin/sh\nprintf "%s\\n" "$@"\n'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = '',
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out (${stdout} ${stderr})`))
    }, 20_000)
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function tomlCommands(arg: string): string[] {
  return [...arg.matchAll(/command=("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1] ?? '""'))
}

describe('extension agent skills and hooks reach a fake agent (real CLI, real socket)', () => {
  let dir: string
  let bin: string
  let socketPath: string
  let agentDir: string
  let identity: PaneIdentity
  let host: ExtensionHost
  const notify = vi.fn()

  function paneEnv(): NodeJS.ProcessEnv {
    return {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      PINE_CLI: cliPath,
      PINE_NODE: process.execPath,
      PINE_SOCKET: socketPath,
      PINE_TOKEN: identity.token,
      PINE_AGENT_DIR: agentDir,
    }
  }

  function inPane(script: string): Promise<RunResult> {
    const bashInit = join(INTEGRATION_DIR, 'init.bash')
    return run('bash', ['--norc', '-c', `source '${bashInit}'; ${script}`], paneEnv())
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-agent-plugin-'))
    bin = join(dir, 'bin')
    socketPath = join(dir, 'control.sock')
    identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pAgentPlugin' })
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => dir,
      broadcast: () => {},
      openPanelIn: () => {},
      notify,
      requestTimeoutMs: 5000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
    shellIntegrationSpawnOptions('/bin/bash', {})
    agentDir = setAgentPlugins(agentPluginContent(host.agentPlugins()))
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
    writeFileSync(join(bin, 'codex'), FAKE_CODEX)
    chmodSync(join(bin, 'claude'), 0o755)
    chmodSync(join(bin, 'codex'), 0o755)
  }, 120_000)

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    notify.mockReset()
  })

  it('gives claude the declared skill files and runs the extension command for each hook', async () => {
    const res = await inPane('claude')
    expect(res.stderr).toBe('')
    const lines = res.stdout.split('\n').map((line) => line.trimEnd())
    expect(lines).toContain('skill agent-kit-review SKILL.md,checklist.md')
    expect(lines).toContain('skill pine SKILL.md')
    expect(res.stdout).not.toContain('agent-kit-undeclared')
    expect(res.stdout).not.toContain('undeclared.md')
    expect(lines).toContain(
      `hook SessionStart ${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'agent-kit saw claude SessionStart for s-1',
        },
      })}`,
    )
    expect(lines).toContain('hook PreToolUse')
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'agent-kit claude PreToolUse', body: 's-1 Bash' }),
    )
    const hooks = JSON.parse(
      readFileSync(join(agentDir, 'claude-plugin', 'hooks', 'hooks.json'), 'utf8'),
    ).hooks
    expect(JSON.stringify(hooks.Notification)).toContain('agent-hook agent-kit on-hook claude')
    expect(
      readFileSync(
        join(agentDir, 'claude-plugin', 'skills', 'agent-kit-review', 'SKILL.md'),
        'utf8',
      ),
    ).toMatch(/^---\nname: agent-kit-review\ndescription: Use when reviewing/)
  }, 60_000)

  it('gives codex trusted hooks that reach the extension and lists the skill in its context', async () => {
    const res = await inPane('codex')
    const args = res.stdout.trim().split('\n')
    expect(args[0]).toBe('--no-daemon')
    expect(args.join('\n')).not.toContain('Notification')
    const sessionStart = args.find((arg) => arg.startsWith('hooks.SessionStart=')) ?? ''
    const commands = tomlCommands(sessionStart)
    const index = commands.findIndex((command) => command.includes(' agent-hook '))
    expect(index).toBe(3)
    const command = commands[index] ?? ''
    expect(command).toContain('agent-hook agent-kit on-hook codex SessionStart')
    const state = args[args.length - 1] ?? ''
    expect(state).toContain(
      `${JSON.stringify(codexHookKey('SessionStart', index))}={trusted_hash=${JSON.stringify(
        codexHookTrustHash('SessionStart', command),
      )}}`,
    )
    const hook = await run(
      'sh',
      ['-c', command],
      paneEnv(),
      JSON.stringify({ session_id: 'c-9', hook_event_name: 'SessionStart' }),
    )
    expect(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext).toBe(
      'agent-kit saw codex SessionStart for c-9',
    )
    const context = readFileSync(join(agentDir, 'codex', 'session-context.md'), 'utf8')
    const skillFile = join(agentDir, 'codex', 'skills', 'agent-kit-review', 'SKILL.md')
    expect(context).toContain(`- agent-kit-review (${skillFile}): Use when reviewing a change`)
    expect(existsSync(skillFile)).toBe(true)
    expect(context).not.toContain('agent-kit-undeclared')
  }, 60_000)

  it('fails quietly and adds nothing when Pine cannot be reached', async () => {
    const res = await run(
      'sh',
      [
        '-c',
        extensionHookCommand(
          { extId: 'agent-kit', command: 'on-hook', event: 'SessionStart' },
          'claude',
        ),
      ],
      { ...paneEnv(), PINE_SOCKET: join(dir, 'missing.sock') },
      '{}',
    )
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  }, 30_000)
})
