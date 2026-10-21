import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'

export function playbookEnabled(raw: unknown, id: string): boolean {
  return isRecord(raw) && isRecord(raw.enabled) && raw.enabled[id] === true
}
