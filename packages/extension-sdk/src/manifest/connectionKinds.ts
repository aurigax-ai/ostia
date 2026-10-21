import {
  EXTENSION_CONNECTION_FIELD_TYPES,
  EXTENSION_CONNECTION_FIELDS_MAX,
  EXTENSION_CONNECTION_KIND_PATTERN,
  EXTENSION_CONNECTION_KINDS_MAX,
  EXTENSION_CONNECTION_SECRETS_MAX,
  EXTENSION_CONNECTION_VALUE_MAX,
  type ExtensionConnectionField,
  type ExtensionConnectionFieldType,
  type ExtensionConnectionKind,
  type ExtensionConnectionSecret,
} from '../contract/extensionConnections'
import { EXTENSION_SETTING_TITLE_MAX } from '../contract/extensions'
import { isRecord } from '../contract/isRecord'

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/
const DESCRIPTION_MAX = 500
const ENUM_MAX = 32

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function title(raw: unknown): string | null {
  return typeof raw === 'string' &&
    raw.trim() &&
    raw.length <= EXTENSION_SETTING_TITLE_MAX &&
    !hasControl(raw)
    ? raw
    : null
}

function description(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined
  return typeof raw === 'string' && raw.trim() && raw.length <= DESCRIPTION_MAX ? raw : null
}

function labelled(
  where: string,
  key: string,
  raw: unknown,
): { title: string; description?: string } | string {
  if (!KEY_PATTERN.test(key)) return `${where}: invalid key`
  if (!isRecord(raw)) return `${where}: must be an object`
  const t = title(raw.title)
  if (!t) return `${where}: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
  const d = description(raw.description)
  if (d === null) return `${where}: description must be 1-${DESCRIPTION_MAX} characters`
  return { title: t, ...(d ? { description: d } : {}) }
}

function parseField(where: string, key: string, raw: unknown): ExtensionConnectionField | string {
  const base = labelled(where, key, raw)
  if (typeof base === 'string') return base
  const r = raw as Record<string, unknown>
  if (!EXTENSION_CONNECTION_FIELD_TYPES.includes(r.type as ExtensionConnectionFieldType)) {
    return `${where}: type must be one of ${EXTENSION_CONNECTION_FIELD_TYPES.join(', ')}`
  }
  const field: ExtensionConnectionField = {
    key,
    ...base,
    type: r.type as ExtensionConnectionFieldType,
  }
  if (r.type === 'enum') {
    if (
      !Array.isArray(r.enum) ||
      r.enum.length === 0 ||
      r.enum.length > ENUM_MAX ||
      !r.enum.every((v) => typeof v === 'string' && title(v) !== null) ||
      new Set(r.enum).size !== r.enum.length
    ) {
      return `${where}: enum must be 1-${ENUM_MAX} distinct strings`
    }
    field.enum = r.enum as string[]
  } else if (r.enum !== undefined) {
    return `${where}: enum is for enum fields`
  }
  if (r.default !== undefined) {
    if (typeof r.default !== 'string' || r.default.length > EXTENSION_CONNECTION_VALUE_MAX) {
      return `${where}: default must be a string`
    }
    if (field.enum && !field.enum.includes(r.default)) return `${where}: default is not in enum`
    field.default = r.default
  }
  if (r.required !== undefined) {
    if (typeof r.required !== 'boolean') return `${where}: required must be a boolean`
    if (r.required) field.required = true
  }
  return field
}

function parseKind(where: string, raw: unknown): ExtensionConnectionKind | string {
  if (!isRecord(raw)) return `${where}: must be an object`
  if (typeof raw.kind !== 'string' || !EXTENSION_CONNECTION_KIND_PATTERN.test(raw.kind)) {
    return `${where}: invalid kind`
  }
  const t = title(raw.title)
  if (!t) return `${where}: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
  const d = description(raw.description)
  if (d === null) return `${where}: description must be 1-${DESCRIPTION_MAX} characters`
  if (!isRecord(raw.fields)) return `${where}: fields must be an object`
  const fieldEntries = Object.entries(raw.fields)
  if (fieldEntries.length > EXTENSION_CONNECTION_FIELDS_MAX) {
    return `${where}: more than ${EXTENSION_CONNECTION_FIELDS_MAX} fields`
  }
  const fields: ExtensionConnectionField[] = []
  for (const [key, value] of fieldEntries) {
    const field = parseField(`${where}.fields.${key}`, key, value)
    if (typeof field === 'string') return field
    fields.push(field)
  }
  if (raw.secrets !== undefined && !isRecord(raw.secrets)) {
    return `${where}: secrets must be an object`
  }
  const secretEntries = Object.entries((raw.secrets ?? {}) as Record<string, unknown>)
  if (secretEntries.length > EXTENSION_CONNECTION_SECRETS_MAX) {
    return `${where}: more than ${EXTENSION_CONNECTION_SECRETS_MAX} secrets`
  }
  const secrets: ExtensionConnectionSecret[] = []
  for (const [key, value] of secretEntries) {
    if (fields.some((f) => f.key === key)) return `${where}.secrets.${key}: also a field`
    const secret = labelled(`${where}.secrets.${key}`, key, value)
    if (typeof secret === 'string') return secret
    secrets.push({ key, ...secret })
  }
  return { kind: raw.kind, title: t, ...(d ? { description: d } : {}), fields, secrets }
}

export function parseConnectionKinds(raw: unknown): ExtensionConnectionKind[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > EXTENSION_CONNECTION_KINDS_MAX) {
    return `contributes.connections must be an array of 1-${EXTENSION_CONNECTION_KINDS_MAX} kinds`
  }
  const kinds: ExtensionConnectionKind[] = []
  for (const [i, item] of raw.entries()) {
    const kind = parseKind(`contributes.connections[${i}]`, item)
    if (typeof kind === 'string') return kind
    if (kinds.some((k) => k.kind === kind.kind)) {
      return `contributes.connections[${i}]: kind ${kind.kind} is declared twice`
    }
    kinds.push(kind)
  }
  return kinds
}
