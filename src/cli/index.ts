#!/usr/bin/env node
import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { controlInfoPath, readControlSocket } from '../main/control/controlDiscovery'
import { appDataDir } from '../main/platform/userDirs'
import { SCRIPT_TOKEN_PREFIX } from '../shared/permissions/scriptTokens'
import { FlagError } from './common/args'
import { wantsHelp } from './common/commandHelp'
import { commandLabel, describeFailure, fail, failVerb } from './common/failure'
import { paneToken } from './common/paneToken'
import { readAllStdin } from './common/stdinText'
import { topUsage, type UsageAnswer, usageGate } from './common/usageTable'
import { buildVersionAt } from './common/version'
import { skewMarkFile, versionSkewWarning } from './common/versionSkew'
import { runAgentHook } from './hooks/agentHook'
import { runClaudeHookVerb, runResumeTokenVerb, runTurnHookVerb } from './hooks/agentReports'
import { saveAttentionOffline } from './hooks/offlineAttention'
import { runPermissionHook } from './hooks/permissionHook'
import { runTokenVerb } from './hooks/token'
import { runAskVerb } from './verbs/ask'
import { runNotify, runStateVerb } from './verbs/attention'
import { runBrowse } from './verbs/browse'
import { runBusVerb } from './verbs/bus'
import { runCmuxImportVerb } from './verbs/cmuxImport'
import { runCodexServerVerb } from './verbs/codexServer'
import { runCommandList, runRawCommand } from './verbs/commands'
import { runGitVerb, runPortsVerb } from './verbs/coreBoards'
import { runExtCommand, runExtList } from './verbs/ext'
import { runGatewayVerb } from './verbs/gateway'
import { runInstallPolkit } from './verbs/installPolkit'
import { runDocs, runWhoami } from './verbs/introspection'
import { runManagerVerb } from './verbs/manager'
import { opensAsTarget, opensOffline, runDiffFiles, runOpenFiles } from './verbs/open'
import { runPaneVerb } from './verbs/pane'
import { runPortalCommand } from './verbs/portal'
import { runAgentVerb, runProcessVerb } from './verbs/process'
import { runSandboxVerb, runSecretVerb } from './verbs/sandbox'
import { runSettingsVerb } from './verbs/settings'
import { runSnippetVerb } from './verbs/snippet'
import { runVaultVerb } from './verbs/vault'
import { isOfflineViewVerb, runOfflineViewVerb, runViewVerb } from './verbs/view'
import { runWorkspaceVerb, workspaceFolderIn } from './verbs/workspace'

async function connectSocket(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath)
  await once(socket, 'connect')
  return socket
}

type Runner = (conn: MessageConnection) => Promise<void>

const argvFrom3 = (): string[] => process.argv.slice(3)

const RUNNERS: Readonly<Record<string, Runner>> = {
  whoami: runWhoami,
  commands: runCommandList,
  docs: runDocs,
  notify: runNotify,
  ask: async (conn) => {
    process.exitCode = await runAskVerb(conn, argvFrom3(), readAllStdin)
  },
  state: runStateVerb,
  workspace: runWorkspaceVerb,
  'resume-token': runResumeTokenVerb,
  'claude-hook': runClaudeHookVerb,
  'turn-hook': runTurnHookVerb,
  'codex-server': runCodexServerVerb,
  'permission-hook': async (conn) => {
    process.exitCode = await runPermissionHook(argvFrom3(), {
      readInput: readAllStdin,
      ask: (params) => conn.sendRequest('permission.ask', params),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  },
  'agent-hook': async (conn) => {
    process.exitCode = await runAgentHook(argvFrom3(), {
      readInput: readAllStdin,
      invoke: (params) => conn.sendRequest('ext.invoke', params),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  },
  snippet: runSnippetVerb,
  git: (conn) => runGitVerb(conn, argvFrom3()),
  ports: (conn) => runPortsVerb(conn, argvFrom3()),
  view: (conn) => runViewVerb(conn, argvFrom3()),
  open: (conn) => runOpenFiles(conn, argvFrom3()),
  diff: (conn) => runDiffFiles(conn, argvFrom3()),
  process: runProcessVerb,
  agent: runAgentVerb,
  pane: async (conn) => {
    process.exitCode = await runPaneVerb(conn, argvFrom3(), readAllStdin)
  },
  token: async (conn) => {
    process.exitCode = await runTokenVerb(conn, argvFrom3())
  },
  cmux: async (conn) => {
    process.exitCode = await runCmuxImportVerb(conn, process.argv.slice(4), process.cwd())
  },
  vault: runVaultVerb,
  sandbox: runSandboxVerb,
  secret: runSecretVerb,
  ext: runExtList,
  manager: async (conn) => {
    process.exitCode = await runManagerVerb(conn, argvFrom3(), process.cwd())
  },
  bus: runBusVerb,
  settings: runSettingsVerb,
  browse: (conn) => runBrowse(conn, argvFrom3()),
  gateway: runGatewayVerb,
}

function printUsage(answer: UsageAnswer): void {
  if (answer.code === 0) console.log(answer.text)
  else console.error(answer.text)
  process.exitCode = answer.code
}

async function main(): Promise<void> {
  const token = paneToken()
  const socketPath =
    readEnv('SOCKET') ??
    (token?.startsWith(SCRIPT_TOKEN_PREFIX) ? readControlSocket(controlInfoPath()) : undefined)
  const argv = process.argv.slice(2)
  const [cmd] = argv
  if (cmd === '--version') {
    const version = buildVersionAt(__dirname)
    if (version) console.log(version)
    else fail('ostia: build-info.json is missing')
    return
  }
  if (cmd === 'polkit' && argv[1] === 'install') {
    process.exitCode = runInstallPolkit(argv.slice(2), {
      platform: process.platform,
      uid: process.getuid?.(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
    return
  }
  if (isOfflineViewVerb(argv)) {
    process.exitCode = runOfflineViewVerb(argv)
    return
  }
  if (!socketPath) {
    if (cmd !== undefined && wantsHelp(cmd)) return printUsage({ text: topUsage(), code: 0 })
    if (cmd === 'open' || (cmd !== undefined && opensOffline(cmd))) {
      return fail('ostia: files open from a terminal inside Ostia')
    }
    process.exitCode = await runPortalCommand(
      argv,
      {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        cwd: process.cwd(),
      },
      { platform: process.platform, isVerb: (name) => Object.hasOwn(RUNNERS, name) },
    )
    return
  }
  const gated = usageGate(argv)
  if (gated) return printUsage(gated)
  let socket: Socket
  try {
    socket = await connectSocket(socketPath)
  } catch {
    if (await saveAttentionOffline(argv, readAllStdin)) return
    console.error(`ostia: app not reachable at ${socketPath}`)
    process.exit(1)
  }
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  let done = false
  let connectionLost = false
  const onLost = (): void => {
    if (done || connectionLost) return
    connectionLost = true
    process.exitCode = 1
    conn.dispose()
  }
  socket.on('error', onLost)
  socket.on('close', onLost)
  conn.onClose(onLost)
  conn.listen()
  try {
    const hello = await conn.sendRequest<{ version?: string }>('hello', {
      token,
      pid: process.ppid,
    })
    const skew = versionSkewWarning(
      hello?.version,
      buildVersionAt(__dirname),
      skewMarkFile(join(appDataDir(), 'cli-version-skew')),
    )
    if (skew) console.error(skew)
    const runner = Object.hasOwn(RUNNERS, cmd) ? RUNNERS[cmd] : undefined
    if (runner) await runner(conn)
    else if (await opensAsTarget(conn, cmd)) await runOpenFiles(conn, argv, workspaceFolderIn)
    else if (cmd.includes('.')) await runRawCommand(conn, cmd)
    else await runExtCommand(conn, cmd, process.argv[3], process.argv.slice(4))
  } catch (e) {
    if (connectionLost) {
      console.error('ostia: connection to the app closed (did Ostia quit?)')
    } else if (e instanceof FlagError) {
      failVerb(e.message)
    } else {
      console.error(`${commandLabel()}:`, describeFailure(e))
    }
    process.exitCode = 1
  } finally {
    done = true
    conn.dispose()
    socket.destroy()
  }
}
void main()
