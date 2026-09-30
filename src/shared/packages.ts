export type PackageEcosystem = 'npm' | 'PyPI' | 'crates.io' | 'Go'

export interface PackageRef {
  ecosystem: PackageEcosystem
  name: string
  version: string
}

export const REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'files.pythonhosted.org',
  'static.crates.io',
  'crates.io',
  'proxy.golang.org',
] as const

function pypiName(raw: string): string {
  return raw.toLowerCase().replace(/[-_.]+/g, '-')
}

function goModule(escaped: string): string {
  return escaped.replace(/!([a-z])/g, (_m, c: string) => c.toUpperCase())
}

export function packageKey(pkg: Pick<PackageRef, 'ecosystem' | 'name'>): string {
  return `${pkg.ecosystem}:${pkg.name}`
}

export function packageVersionKey(pkg: PackageRef): string {
  return `${packageKey(pkg)}@${pkg.version}`
}

export function parsePackageDownload(raw: string): PackageRef | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const path = decodeURIComponent(url.pathname)
  if (url.hostname === 'registry.npmjs.org') {
    const match = /^\/((?:@[^/]+\/)?[^/]+)\/-\/(.+)\.tgz$/.exec(path)
    if (!match) return null
    const name = match[1]
    const base = name.includes('/') ? name.split('/')[1] : name
    if (!match[2].startsWith(`${base}-`)) return null
    return { ecosystem: 'npm', name, version: match[2].slice(base.length + 1) }
  }
  if (url.hostname === 'files.pythonhosted.org') {
    const file = path.split('/').pop() ?? ''
    const wheel = /^([^-]+)-([^-]+)-.+\.whl$/.exec(file)
    if (wheel) return { ecosystem: 'PyPI', name: pypiName(wheel[1]), version: wheel[2] }
    const sdist = /^(.+?)-(\d[^-]*)\.(?:tar\.gz|zip|tar\.bz2)$/.exec(file)
    if (sdist) return { ecosystem: 'PyPI', name: pypiName(sdist[1]), version: sdist[2] }
    return null
  }
  if (url.hostname === 'static.crates.io') {
    const match = /^\/crates\/([^/]+)\/\1-(.+)\.crate$/.exec(path)
    return match ? { ecosystem: 'crates.io', name: match[1], version: match[2] } : null
  }
  if (url.hostname === 'crates.io') {
    const match = /^\/api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/.exec(path)
    return match ? { ecosystem: 'crates.io', name: match[1], version: match[2] } : null
  }
  if (url.hostname === 'proxy.golang.org') {
    const match = /^\/(.+)\/@v\/(.+)\.zip$/.exec(path)
    return match ? { ecosystem: 'Go', name: goModule(match[1]), version: match[2] } : null
  }
  return null
}
