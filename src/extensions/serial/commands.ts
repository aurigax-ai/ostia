import {
  type CommandHandler,
  type ConfirmRequest,
  type ExtensionResult,
  type OpenTerminalResult,
  cliArgs,
  failure,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import type {
  ExtensionCaller,
  OpenTerminalOptions,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { bridgeCommand, lineText, paneTitle } from './bridge'
import {
  DEFAULT_FRAME,
  DEFAULT_SPEED,
  type LineSettings,
  deviceGlobs,
  frameText,
  isSerialDevice,
  parseFrame,
  parseSpeed,
} from './settings'
import { CONNECT_USAGE, PANE_TITLE, type Strings, stringsFor } from './strings'

export interface SerialDeps {
  platform: NodeJS.Platform
  devices: () => string[]
  execPath: string
  script: string
  confirm: (req: ConfirmRequest) => Promise<boolean>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
}

type Target = { device: string; line: LineSettings }

export function parseTarget(
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

function confirmRequest(target: Target | null, s: Strings): ConfirmRequest {
  const device = target?.device ?? '?'
  const line = target ? lineText(target.line) : `${DEFAULT_SPEED} ${DEFAULT_FRAME}`
  return {
    title: s.confirmTitle,
    message: s.confirmMessage(device),
    detail: s.confirmDetail(device, line),
    confirmLabel: s.connect,
    cancelLabel: s.deny,
  }
}

function describe(target: Target | null): Record<string, unknown> {
  if (!target) return { pick: true }
  return { device: target.device, speed: target.line.speed, frame: frameText(target.line.frame) }
}

export function serialCommands(deps: SerialDeps): Record<'ls' | 'connect', CommandHandler> {
  const refused = (caller: ExtensionCaller, s: Strings): ExtensionResult | null => {
    if (caller.sandboxed) return failure('sandboxed', s.sandboxed)
    if (deviceGlobs(deps.platform).length === 0) return failure('unsupported', s.unsupported)
    return null
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
      const target = parseTarget(cliArgs(args)?.argv ?? [], deps.platform, s)
      if (isFailure(target)) return target
      const summary = describe(target)
      if (caller.kind === 'pane' && !(await deps.confirm(confirmRequest(target, s)))) {
        return {
          ok: false,
          error: 'denied',
          message: s.denied,
          data: { approved: false, ...summary },
        }
      }
      const opened = await deps.openTerminal({
        command: bridgeCommand(deps.execPath, deps.script, caller.locale, target ?? undefined),
        workspaceId: caller.workspaceId,
        afterPaneId: caller.paneId,
        title: target ? paneTitle(target.device, target.line) : PANE_TITLE,
      })
      if (!opened.ok) {
        return failure('not-opened', s.notOpened(opened.message ?? opened.error))
      }
      return ok(undefined, { approved: true, ...summary, paneId: opened.paneId })
    },
  }
}
