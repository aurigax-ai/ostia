export const EXTENSION_CONNECTION_FIELD_TYPES = ['string', 'enum'] as const

export type ExtensionConnectionFieldType = (typeof EXTENSION_CONNECTION_FIELD_TYPES)[number]

export interface ExtensionConnectionField {
  key: string
  title: string
  description?: string
  type: ExtensionConnectionFieldType
  enum?: string[]
  default?: string
  required?: boolean
}

export interface ExtensionConnectionSecret {
  key: string
  title: string
  description?: string
}

export interface ExtensionConnectionKind {
  kind: string
  title: string
  description?: string
  fields: ExtensionConnectionField[]
  secrets: ExtensionConnectionSecret[]
}

export const EXTENSION_CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

export const EXTENSION_CONNECTION_KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/

export const EXTENSION_CONNECTIONS_MAX = 32

export const EXTENSION_CONNECTION_KINDS_MAX = 8

export const EXTENSION_CONNECTION_FIELDS_MAX = 8

export const EXTENSION_CONNECTION_SECRETS_MAX = 4

export const EXTENSION_CONNECTION_VALUE_MAX = 2048

export interface ExtensionConnectionEntry {
  name: string
  kind: string
  fields: Record<string, string>
  secretsSet: string[]
}

export interface ExtensionConnectionSave {
  name: string
  kind: string
  fields: Record<string, string>
  secrets?: Record<string, string | null>
}

export type ExtensionConnectionResult = { ok: true } | { ok: false; error: string }

export interface ConnectionInfo {
  name: string
  kind: string
}

export interface ConnectionValue {
  name: string
  kind: string
  fields: Record<string, string>
  secrets: Record<string, string>
}

export const CONNECTIONS_CHANGED_EVENT = 'connections.changed'
