export interface OsRelease {
  id: string
  idLike: string[]
  name: string
  version: string
}

export interface OsIdentity extends OsRelease {
  platform: string
}

const LINE = /^([A-Z0-9_]+)=(.*)$/

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([\\"$`])/g, '$1')
  }
  return value
}

export function parseOsRelease(text: string): OsRelease {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line.trim())
    if (match) fields.set(match[1], unquote(match[2]))
  }
  const id = (fields.get('ID') ?? 'linux').toLowerCase()
  return {
    id,
    idLike: (fields.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    name: fields.get('PRETTY_NAME') || fields.get('NAME') || id,
    version: fields.get('VERSION_ID') ?? fields.get('BUILD_ID') ?? '',
  }
}

export function parseSwVers(text: string): OsRelease {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  const name = fields.get('ProductName') || 'macOS'
  const version = fields.get('ProductVersion') ?? ''
  return { id: 'macos', idLike: [], name: version ? `${name} ${version}` : name, version }
}

export function windowsRelease(release: string): OsRelease {
  return { id: 'windows', idLike: [], name: `Windows ${release}`, version: release }
}
