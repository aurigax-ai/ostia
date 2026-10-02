import type { ChatFsError } from '@shared/chatTools'
import { saveSession } from '../stores/chatStore'
import { type ChatEditRecord, nextSeq, useChatToolsStore } from '../stores/chatToolsStore'
import { restoreFile } from './chatReview'

interface MessageLike {
  id: string
  role: string
  parts: readonly { type: string; toolCallId?: unknown }[]
}

export interface CheckpointFile {
  path: string
  root: string
  outside: boolean
  symlink: boolean
  expected: string | null
  content: string | null
  kept: boolean
  created: boolean
  toolCallIds: string[]
}

export type CheckpointStatus = 'ready' | 'unchanged' | 'not-kept' | ChatFsError

export interface CheckpointCheck {
  file: CheckpointFile
  status: CheckpointStatus
}

function callOrder(messages: readonly MessageLike[]): Map<string, number> {
  const order = new Map<string, number>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (typeof part.toolCallId === 'string' && !order.has(part.toolCallId)) {
        order.set(part.toolCallId, order.size)
      }
    }
  }
  return order
}

function callsAfter(messages: readonly MessageLike[], index: number): Set<string> {
  const calls = new Set<string>()
  for (const message of messages.slice(index + 1)) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (typeof part.toolCallId === 'string') calls.add(part.toolCallId)
    }
  }
  return calls
}

export function checkpointFiles(
  messages: readonly MessageLike[],
  records: readonly ChatEditRecord[],
  messageId: string,
): CheckpointFile[] {
  const index = messages.findIndex((m) => m.id === messageId)
  if (index < 0 || messages[index].role !== 'user') return []
  const later = callsAfter(messages, index)
  const order = callOrder(messages)
  const files: CheckpointFile[] = []
  const paths = [...new Set(records.filter((r) => later.has(r.toolCallId)).map((r) => r.path))]
  for (const path of paths) {
    const ofPath = records.filter((r) => r.path === path)
    const changed = ofPath
      .filter((r) => later.has(r.toolCallId))
      .sort((a, b) => (order.get(a.toolCallId) ?? 0) - (order.get(b.toolCallId) ?? 0))
    if (!changed.some((r) => r.state === 'applied')) continue
    const first = changed[0]
    const latest = ofPath.reduce((a, b) => (b.seq > a.seq ? b : a))
    files.push({
      path,
      root: first.root,
      outside: ofPath.some((r) => r.outside),
      symlink: ofPath.some((r) => r.symlink),
      expected: latest.version,
      content: first.existed ? (first.before ?? null) : null,
      kept: !first.existed || first.before !== undefined,
      created: !first.existed,
      toolCallIds: changed.map((r) => r.toolCallId),
    })
  }
  return files
}

export async function checkCheckpoint(
  files: readonly CheckpointFile[],
): Promise<CheckpointCheck[]> {
  return Promise.all(
    files.map(async (file) => {
      if (!file.kept) return { file, status: 'not-kept' as const }
      const res = await restoreFile(file, file.expected, file.content, true)
      if (!res.ok) return { file, status: res.error }
      return { file, status: res.version === file.expected ? 'unchanged' : 'ready' }
    }),
  )
}

export async function restoreCheckpoint(
  sessionId: string,
  files: readonly CheckpointFile[],
): Promise<CheckpointCheck[]> {
  const results: CheckpointCheck[] = []
  for (const file of files) {
    const res = await restoreFile(file, file.expected, file.content)
    if (!res.ok) {
      results.push({ file, status: res.error })
      continue
    }
    const store = useChatToolsStore.getState()
    file.toolCallIds.forEach((id, i) => {
      const edit = useChatToolsStore.getState().edits[id]
      if (!edit) return
      const { undoError: _cleared, ...rest } = edit
      store.recordEdit(
        i === 0
          ? { ...rest, state: 'undone', version: res.version, seq: nextSeq(sessionId) }
          : { ...rest, state: 'undone' },
      )
    })
    store.setVersion(sessionId, file.path, res.version)
    results.push({ file, status: 'ready' })
  }
  void saveSession(sessionId)
  return results
}
