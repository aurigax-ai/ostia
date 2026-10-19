import { spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerControlServer, stopControlServer } from '../main/control/controlServer'
import { type PaneIdentity, registerPane } from '../main/control/idRegistry'
import { ExtensionHost } from '../main/extensions/extensionHost'
import { registerExtensionMethods } from '../main/extensions/extensionMethods'
import { ExtensionStore } from '../main/extensions/extensionStore'
import { registerPaneListMethods } from '../main/panes/paneList'
import { createRedactor } from '../main/privacy/redaction'
import { scanSecrets } from '../main/privacy/secretScanner'
import {
  setAgentPlugins,
  shellIntegrationDir,
  shellIntegrationSpawnOptions,
} from '../main/terminal/shellIntegration'
import type { CommandResult } from '../shared/control/commands'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')
const builtExtension = join(repoRoot, 'out', 'extensions', 'skills')

const FAKE_AGENT = `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const agent = process.argv[1].endsWith('codex') ? 'codex' : 'claude'
const args = process.argv.slice(2)
let commands = []
if (agent === 'claude') {
  const dir = args[args.indexOf('--plugin-dir') + 1]
  const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks
  commands = (hooks.SessionStart || []).flatMap((group) => group.hooks.map((hook) => hook.command))
} else {
  for (const arg of args) {
    if (!arg.startsWith('hooks.SessionStart=')) continue
    commands = [...arg.matchAll(/command=("(?:[^"\\\\]|\\\\.)*")/g)].map((m) => JSON.parse(m[1]))
  }
}
for (const command of commands) {
  if (!command.includes(' agent-hook skills ')) continue
  const out = execFileSync('sh', ['-c', command], { input: '{}', encoding: 'utf8' })
  const text = out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : ''
  console.log('context [' + text + ']')
}
`

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out (${stdout} ${stderr})`))
    }, 30_000)
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
    child.stdin.end('')
  })
}

const workspaces = [
  { workspaceId: 'w1', name: 'shop', kind: 'terminal' },
  { workspaceId: 'sb1', name: 'boxed', kind: 'terminal' },
  { workspaceId: 'sc1', name: 'notes', kind: 'scratch' },
]

function rule(id: string, text: string, scope: string, state = 'active') {
  return { id, rule: text, why: 'private', when: '', scope, state, origin: 'human', createdAt: 1 }
}

describe('Skill Workshop gives agents their rules at session start (real CLI, real socket)', () => {
  let dir: string
  let bin: string
  let socketPath: string
  let agentDir: string
  let host: ExtensionHost
  let panes: Record<string, PaneIdentity>
  const redactor = createRedactor(
    () => ({ redaction: { enabled: true } }),
    (text) => scanSecrets(text),
  )

  function runAgent(agent: 'claude' | 'codex', identity: PaneIdentity): Promise<RunResult> {
    const bashInit = join(shellIntegrationDir(), 'init.bash')
    return run('bash', ['--norc', '-c', `source '${bashInit}'; ${agent}`], {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      OSTIA_CLI: cliPath,
      OSTIA_NODE: process.execPath,
      OSTIA_SOCKET: socketPath,
      OSTIA_TOKEN: identity.token,
      OSTIA_AGENT_DIR: agentDir,
    })
  }

  const context = (res: RunResult): string => {
    expect(res.stderr).toBe('')
    return /context \[([\s\S]*)\]/.exec(res.stdout)?.[1] ?? ''
  }

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-skills-')))
    bin = join(dir, 'bin')
    socketPath = join(dir, 'control.sock')
    const dataDir = join(dir, 'extension-data')
    mkdirSync(join(dataDir, 'skills'), { recursive: true })
    writeFileSync(
      join(dataDir, 'skills', 'rules.json'),
      JSON.stringify({
        next: 5,
        rules: [
          rule('r1', 'Write no code comments.', 'global'),
          rule('r2', 'Keep pull requests to one area.', `project:${dir}`),
          rule('r3', 'Retired rule text.', 'global', 'retired'),
          rule('r4', 'Rust only rule.', 'stack:rust'),
        ],
      }),
    )
    cpSync(builtExtension, join(dir, 'builtin', 'skills'), { recursive: true })
    panes = {
      claude: registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pSkillsClaude' }),
      codex: registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pSkillsCodex' }),
      boxed: registerPane({ windowId: 'w', workspaceId: 'sb1', paneId: 'pSkillsBoxed' }),
      scratch: registerPane({ windowId: 'w', workspaceId: 'sc1', paneId: 'pSkillsScratch' }),
    }
    host = new ExtensionHost({
      roots: [{ dir: join(dir, 'builtin'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir,
      workDirForWorkspace: () => dir,
      isSandboxed: (workspaceId) => workspaceId === 'sb1',
      sandboxDomains: () => null,
      broadcast: () => {},
      readExtensionSettings: () => ({}),
      redact: redactor.redact,
      focusPaneIn: () => false,
      openPanelIn: () => {},
      notify: () => {},
      requestTimeoutMs: 8000,
      readyTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerPaneListMethods({
      execCommand: async (_target, id) =>
        ({
          ok: true,
          result:
            id === 'workspace.list'
              ? workspaces.map((w) => ({ ...w, workDir: dir, state: 'idle' }))
              : [],
        }) as CommandResult,
      getTerminalState: () => undefined,
      ptyPid: () => undefined,
      windowIds: () => ['w'],
      waking: () => false,
    })
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: (workspaceId) => workspaceId === 'sb1',
      },
      socketPath,
    )
    shellIntegrationSpawnOptions('/bin/bash', {})
    agentDir = setAgentPlugins(agentPluginContent(host.contributions.agentPlugins()))
    mkdirSync(bin, { recursive: true })
    for (const agent of ['claude', 'codex']) {
      writeFileSync(join(bin, agent), FAKE_AGENT)
      chmodSync(join(bin, agent), 0o755)
    }
  }, 120_000)

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['claude', 'codex'] as const)(
    'gives %s the active rules that apply to its folder',
    async (agent) => {
      const text = context(await runAgent(agent, panes[agent]))
      expect(text).toContain('They are preferences, not permissions')
      expect(text).toContain('- Keep pull requests to one area. [r2]')
      expect(text).toContain('- Write no code comments. [r1]')
      expect(text.indexOf('[r2]')).toBeLessThan(text.indexOf('[r1]'))
      expect(text).not.toContain('Retired rule text')
      expect(text).not.toContain('Rust only')
      expect(text).not.toContain('private')
    },
  )

  it('gives a sandboxed pane and a scratch pane nothing', async () => {
    expect(context(await runAgent('claude', panes.boxed))).toBe('')
    expect(context(await runAgent('claude', panes.scratch))).toBe('')
  })
})
