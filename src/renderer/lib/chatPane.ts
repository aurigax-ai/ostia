import type { ChatContextItem } from '@shared/assist'

export interface OpenChatOptions {
  workspaceId?: string
  context?: ChatContextItem[]
  prompt?: string
  send?: boolean
}

export function openChatPane(_opts: OpenChatOptions = {}): string | null {
  return null
}
