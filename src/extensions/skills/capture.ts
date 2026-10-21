import {
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  namedArgs,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { isHookAgent } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { type FolderScope, projectScopeOf } from './scope'
import { PROMPT_MAX } from './signal'
import type { SignalStore } from './signalStore'

const SESSION_PATTERN = /^[\w.:-]{1,128}$/

export interface CaptureDeps {
  signals: SignalStore
  now: () => number
  redact: (texts: string[]) => Promise<string[] | null>
  workspace: (workspaceId: string) => Promise<{ kind: string; workDir: string } | null>
  folderScopeOf: (dir: string) => Promise<FolderScope>
  confirmForget: (locale: string | undefined) => Promise<boolean>
  changed: () => void
}

type CaptureCommand = (args: unknown, caller: ExtensionCaller) => Promise<ExtensionResult>

function promptOf(stdin: string | undefined): { text: string; session: string } | null {
  let payload: unknown
  try {
    payload = JSON.parse(stdin ?? '')
  } catch {
    return null
  }
  const p = payload as { prompt?: unknown; session_id?: unknown } | null
  if (typeof p?.prompt !== 'string') return null
  const text = p.prompt.trim()
  if (!text || text.length > PROMPT_MAX) return null
  const session =
    typeof p.session_id === 'string' && SESSION_PATTERN.test(p.session_id) ? p.session_id : ''
  return { text, session }
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isHumanPane(caller: ExtensionCaller): caller is ExtensionCaller & {
  paneId: string
  workspaceId: string
} {
  return (
    caller.kind === 'pane' &&
    typeof caller.humanPrompt === 'string' &&
    Boolean(caller.paneId && caller.workspaceId) &&
    !caller.manager &&
    !caller.sandboxed &&
    !caller.remote
  )
}

export function signalCapture(deps: CaptureDeps): {
  onPrompt: CaptureCommand
  panel: Record<string, CaptureCommand>
  settled: () => Promise<void>
} {
  const { signals, now, redact, workspace, folderScopeOf, confirmForget, changed } = deps
  let queue: Promise<void> = Promise.resolve()

  const capture = async (
    agent: 'claude' | 'codex',
    prompt: { text: string; session: string },
    caller: ExtensionCaller & { paneId: string; workspaceId: string },
  ): Promise<void> => {
    const info = await workspace(caller.workspaceId)
    if (!info || info.kind === 'scratch') return
    const clean = await redact([prompt.text])
    const text = clean?.[0]?.trim()
    if (!text) return
    const dir = caller.cwd ?? caller.workDir ?? info.workDir
    const where = dir ? await folderScopeOf(dir) : null
    signals.add({
      at: now(),
      kind: 'prompt',
      agent,
      text,
      session: prompt.session,
      pane: caller.paneId,
      workspace: caller.workspaceId,
      project: where ? projectScopeOf(where) : null,
      stacks: where?.stacks ?? [],
    })
    changed()
  }

  const onPrompt: CaptureCommand = async (args, caller) => {
    const parsed = cliArgs(args)
    const [agent, event] = parsed?.argv ?? []
    if (!isHumanPane(caller) || !isHookAgent(agent) || event !== 'UserPromptSubmit') return ok()
    const prompt = promptOf(parsed?.stdin)
    const typed = caller.humanPrompt
    if (!prompt || typed === undefined || squash(prompt.text) !== squash(typed)) return ok()
    prompt.text = typed
    queue = queue.then(() => capture(agent, prompt, caller)).catch(() => {})
    return ok()
  }

  const list: CaptureCommand = async () => ok(undefined, { signals: signals.list() })

  const remove: CaptureCommand = async (args) => {
    if (!signals.remove(String(namedArgs(args).id ?? ''))) return failure('not-found')
    changed()
    return ok()
  }

  const forget: CaptureCommand = async (_args, caller) => {
    if (!(await confirmForget(caller.locale))) return ok()
    signals.clear()
    changed()
    return ok()
  }

  return {
    onPrompt,
    panel: { signals: list, 'delete-signal': remove, 'forget-signals': forget },
    settled: () => queue,
  }
}
