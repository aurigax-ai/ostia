import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import { messageText } from '@/lib/assist/chatTransport'

const FENCE = '```'

function contextBlock(item: ChatContextItem): string {
  return `${item.label}\n${FENCE}\n${item.text}\n${FENCE}`
}

export function agentPromptText(message: OstiaChatMessage): string {
  const text = messageText(message)
  const context = message.metadata?.context ?? []
  if (context.length === 0) return text
  return `${text}\n\nWhat the human added to this message:\n\n${context.map(contextBlock).join('\n\n')}`
}
