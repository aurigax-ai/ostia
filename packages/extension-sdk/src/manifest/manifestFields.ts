import { ALL_CAPABILITIES, type Capability } from '../contract/capabilities'
import { EXTENSION_ICONS, type ExtensionIcon } from '../contract/extensions'

export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
export const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const MAX_TEXT = 200
export const MAX_DESCRIPTION = 500

export function text(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : null
}

export function capabilities(v: unknown, where: string): Capability[] | string {
  if (v === undefined) return []
  if (!Array.isArray(v)) return `${where}: capabilities must be an array`
  for (const cap of v) {
    if (!ALL_CAPABILITIES.includes(cap as Capability))
      return `${where}: unknown capability '${cap}'`
  }
  return [...new Set(v as Capability[])]
}

export function parseIcon(v: unknown): ExtensionIcon | undefined {
  return EXTENSION_ICONS.includes(v as ExtensionIcon) ? (v as ExtensionIcon) : undefined
}

export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
