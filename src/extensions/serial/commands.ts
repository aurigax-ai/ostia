import { join } from 'node:path'
import {
  type CommandHandler,
  cliArgs,
  type ExtensionResult,
  failure,
  type OpenTerminalResult,
  ok,
  parseFlags,
} from '@aurigax-ai/ostia-extension-sdk'
import type {
  ExtensionCaller,
  OpenTerminalOptions,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { bridgeCommand, paneTitle } from './bridge'
import {
  DEFAULT_FRAME,
  DEFAULT_SPEED,
  deviceGlobs,
  frameText,
  isSerialDevice,
  type LineSettings,
  logName,
  parseFrame,
  parseSpeed,
} from './settings'
import { CONNECT_USAGE, PANE_TITLE, type Strings, stringsFor } from './strings'

export interface SerialDeps {
  platform: NodeJS.Platform
  logDir: () => string | null
  prepareLogDir: (dir: string) => void
  reveal: (dir: string) => Promise<string | null>
  devices: () => string[]
  execPath: string
  script: string
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
}

type Target = { device: string; line: LineSettings }

function parseTarget(
  argv: string[],
  platform: NodeJS.Platform,
  s: Strings,
): Target | null | ExtensionResult {
  if (argv.length === 0) return null
  if (argv.length > 3) return failure('invalid-args', CONNECT_USAGE)
  const [device, speedText = String(DEFAULT_SPEED), frameArg = DEFAULT_FRAME] = argv
  if (!isSerialDevice(device, platform)) {
    return failure('invalid-args', s.badDevice(device, deviceGlobs(platform).join(', ')))
  }
  const speed = parseSpeed(speedText)
  if (speed === null) return failure('invalid-args', s.badSpeed(speedText))
  const frame = parseFrame(frameArg)
  if (frame === null) return failure('invalid-args', s.badFrame(frameArg))
  return { device, line: { speed, frame } }
}

function isFailure(value: Target | null | ExtensionResult): value is ExtensionResult {
  return value !== null && 'ok' in value
}

function describe(target: Target | null, log: string | undefined): Record<string, unknown> {
  const logged = log === undefined ? {} : { log }
  if (!target) return { pick: true, ...logged }
  return {
    device: target.device,
    speed: target.line.speed,
    frame: frameText(target.line.frame),
    ...logged,
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function serialCommands(
  deps: SerialDeps,
): Record<'ls' | 'connect' | 'logs', CommandHandler> {
  const refused = (caller: ExtensionCaller, s: Strings): ExtensionResult | null => {
    if (caller.sandboxed) return failure('sandboxed', s.sandboxed)
    if (deviceGlobs(deps.platform).length === 0) return failure('unsupported', s.unsupported)
    return null
  }

  const logsFolder = (s: Strings): string | ExtensionResult => {
    const dir = deps.logDir()
    if (dir === null) return failure('unsupported', s.noLogDir)
    try {
      deps.prepareLogDir(dir)
    } catch (err) {
      return failure('unsupported', s.logDirUnsafe(reasonOf(err)))
    }
    return dir
  }

  return {
    ls: async (_args, caller) => {
      const s = stringsFor(caller.locale)
      const refusal = refused(caller, s)
      if (refusal) return refusal
      return ok(undefined, { devices: deps.devices() })
    },

    connect: async (args, caller) => {
      const s = stringsFor(caller.locale)
      const refusal = refused(caller, s)
      if (refusal) return refusal
      const { flags, rest } = parseFlags(cliArgs(args)?.argv ?? [], ['log'])
      const name = flags.log
      if (name !== undefined && !logName(name)) {
        return failure('invalid-args', s.badLogName(name))
      }
      const target = parseTarget(rest, deps.platform, s)
      if (isFailure(target)) return target
      const dir = logsFolder(s)
      if (typeof dir !== 'string' && name !== undefined) return dir
      const logs = typeof dir === 'string' ? { dir, name } : undefined
      const summary = describe(
        target,
        logs && name !== undefined ? join(logs.dir, name) : undefined,
      )
      const opened = await deps.openTerminal({
        command: bridgeCommand(
          deps.execPath,
          deps.script,
          caller.locale,
          target ?? undefined,
          logs,
        ),
        workspaceId: caller.workspaceId,
        afterPaneId: caller.paneId,
        title: target ? paneTitle(target.device, target.line) : PANE_TITLE,
      })
      if (!opened.ok) {
        return failure('not-opened', s.notOpened(opened.message ?? opened.error))
      }
      return ok(undefined, { ...summary, paneId: opened.paneId })
    },

    logs: async (_args, caller) => {
      const s = stringsFor(caller.locale)
      const refusal = refused(caller, s)
      if (refusal) return refusal
      const dir = logsFolder(s)
      if (typeof dir !== 'string') return dir
      if (caller.kind === 'user') {
        const failed = await deps.reveal(dir)
        if (failed !== null) return failure('not-opened', s.revealFailed(failed))
      }
      return ok(undefined, { dir })
    },
  }
}
