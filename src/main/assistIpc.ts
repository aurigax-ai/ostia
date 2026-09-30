import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import { CancellationTokenSource } from 'vscode-jsonrpc/node'
import {
  ASSIST_REQUEST_ID_PATTERN,
  type AssistAvailability,
  type AssistExtensionState,
  type AssistPoint,
  type AssistResponse,
  isAssistPoint,
} from '../shared/assist'
import type { AssistCallOptions } from './extensionHost'

export const MAX_ASSIST_REQUESTS_PER_WINDOW = 8

export interface AssistHost {
  assistAvailability: () => AssistAvailability
  assistOverview: () => AssistExtensionState[]
  setShortcuts: (raw: unknown) => void
  assist: <P extends AssistPoint>(
    point: P,
    input: unknown,
    opts?: AssistCallOptions,
  ) => Promise<AssistResponse<P>>
}

export interface AssistSender {
  id: number
  send: (channel: string, payload: unknown) => void
  isDestroyed: () => boolean
  once: (event: 'destroyed', listener: () => void) => void
}

export function createAssistRouter(host: () => AssistHost | null) {
  const live = new Map<string, CancellationTokenSource>()
  const watched = new Set<number>()
  const slot = (senderId: number, requestId: string): string => `${senderId}:${requestId}`
  const countFor = (senderId: number): number =>
    [...live.keys()].filter((key) => key.startsWith(`${senderId}:`)).length

  const cancel = (senderId: number, requestId: unknown): void => {
    if (typeof requestId !== 'string') return
    live.get(slot(senderId, requestId))?.cancel()
  }

  const request = async (
    sender: AssistSender,
    point: unknown,
    requestId: unknown,
    input: unknown,
  ): Promise<AssistResponse<AssistPoint>> => {
    const h = host()
    if (!h) return { ok: false, error: 'unavailable' }
    if (!isAssistPoint(point)) return { ok: false, error: 'invalid' }
    if (typeof requestId !== 'string' || !ASSIST_REQUEST_ID_PATTERN.test(requestId)) {
      return { ok: false, error: 'invalid' }
    }
    const key = slot(sender.id, requestId)
    if (live.has(key)) return { ok: false, error: 'invalid' }
    if (countFor(sender.id) >= MAX_ASSIST_REQUESTS_PER_WINDOW) return { ok: false, error: 'busy' }
    if (!watched.has(sender.id)) {
      watched.add(sender.id)
      sender.once('destroyed', () => {
        watched.delete(sender.id)
        for (const [k, source] of live) if (k.startsWith(`${sender.id}:`)) source.cancel()
      })
    }
    const source = new CancellationTokenSource()
    live.set(key, source)
    let chunks = 0
    try {
      const res = await h.assist(point, input, {
        token: source.token,
        onChunk: (text) => {
          if (sender.isDestroyed()) return
          chunks += 1
          sender.send('assist:chunk', { requestId, text })
        },
      })
      return chunks > 0 ? { ...res, chunks } : res
    } finally {
      live.delete(key)
      source.dispose()
    }
  }

  return { request, cancel, pending: () => live.size }
}

export function registerAssistIpc(host: () => AssistHost | null): void {
  const router = createAssistRouter(host)
  ipcMain.handle('assist:availability', () => host()?.assistAvailability() ?? {})
  ipcMain.handle(
    'assist:request',
    (e: IpcMainInvokeEvent, point: unknown, requestId: unknown, input: unknown) =>
      router.request(e.sender, point, requestId, input),
  )
  ipcMain.on('assist:cancel', (e, requestId: unknown) => router.cancel(e.sender.id, requestId))
  ipcMain.handle('assist:overview', () => host()?.assistOverview() ?? [])
  ipcMain.on('assist:shortcuts', (_e, shortcuts: unknown) => host()?.setShortcuts(shortcuts))
}
