import { CHAT_TOOL_GRANTS_MAX, isStandingChatGrant } from '../../shared/assist/chatTools'
import { loadJson, saveJson } from '../platform/jsonStore'

function storedKeys(file: string): string[] {
  const stored = loadJson<{ keys?: unknown } | null>(file, null)
  if (!Array.isArray(stored?.keys)) return []
  return [...new Set(stored.keys.filter(isStandingChatGrant))].slice(0, CHAT_TOOL_GRANTS_MAX)
}

export class ChatToolGrants {
  private keys: string[]

  constructor(private readonly file: string) {
    this.keys = storedKeys(file)
  }

  list(): string[] {
    return [...this.keys]
  }

  add(key: unknown): boolean {
    if (!isStandingChatGrant(key) || this.keys.includes(key)) return false
    if (this.keys.length >= CHAT_TOOL_GRANTS_MAX) return false
    this.keys = [...this.keys, key]
    this.save()
    return true
  }

  remove(key: unknown): boolean {
    if (typeof key !== 'string' || !this.keys.includes(key)) return false
    this.keys = this.keys.filter((k) => k !== key)
    this.save()
    return true
  }

  private save(): void {
    saveJson(this.file, { keys: this.keys }, { secure: true })
  }
}
