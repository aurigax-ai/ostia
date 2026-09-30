export type SecretSource = 'host' | 'pine'
export type SecretKind = 'ssh-key' | 'env' | 'gh-token' | 'vault'

export interface SecretEntry {
  id: string
  name: string
  source: SecretSource
  kind: SecretKind
  editable: boolean
}

export const SECRET_GRANT_MODES = ['env', 'file', 'request'] as const
export type SecretGrantMode = (typeof SECRET_GRANT_MODES)[number]

export interface SecretGrant {
  id: string
  mode: SecretGrantMode
  name?: string
}
