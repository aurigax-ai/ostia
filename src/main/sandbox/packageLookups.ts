import type { PackageRef } from '../../shared/packages'
import { packageVersionKey } from '../../shared/packages'
import type { MalwareCheck, PackageLookups } from './packagePolicy'

const LOOKUP_TIMEOUT_MS = 8000

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

async function osvMalware(pkg: PackageRef): Promise<MalwareCheck> {
  try {
    const body = (await getJson('https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        package: { name: pkg.name, ecosystem: pkg.ecosystem },
        version: pkg.version,
      }),
    })) as { vulns?: { id?: string }[] }
    return (body.vulns ?? []).some((v) => v.id?.startsWith('MAL-')) ? 'malicious' : 'clean'
  } catch {
    return 'unavailable'
  }
}

async function registryPublishedAt(pkg: PackageRef): Promise<number | null> {
  try {
    if (pkg.ecosystem === 'npm') {
      const body = (await getJson(
        `https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}`,
      )) as { time?: Record<string, string> }
      const at = body.time?.[pkg.version]
      return at ? Date.parse(at) : null
    }
    if (pkg.ecosystem === 'PyPI') {
      const body = (await getJson(`https://pypi.org/pypi/${pkg.name}/${pkg.version}/json`)) as {
        urls?: { upload_time_iso_8601?: string }[]
      }
      const at = body.urls?.[0]?.upload_time_iso_8601
      return at ? Date.parse(at) : null
    }
    if (pkg.ecosystem === 'crates.io') {
      const body = (await getJson(`https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}`, {
        headers: { 'user-agent': 'ostia-sandbox (package cooldown check)' },
      })) as { version?: { created_at?: string } }
      const at = body.version?.created_at
      return at ? Date.parse(at) : null
    }
    const escaped = pkg.name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
    const body = (await getJson(`https://proxy.golang.org/${escaped}/@v/${pkg.version}.info`)) as {
      Time?: string
    }
    return body.Time ? Date.parse(body.Time) : null
  } catch {
    return null
  }
}

export function cachedLookups(): PackageLookups {
  const malware = new Map<string, Promise<MalwareCheck>>()
  const published = new Map<string, Promise<number | null>>()
  return {
    malware: (pkg) => {
      const key = packageVersionKey(pkg)
      const hit = malware.get(key)
      if (hit) return hit
      const next = osvMalware(pkg).then((result) => {
        if (result === 'unavailable') malware.delete(key)
        return result
      })
      malware.set(key, next)
      return next
    },
    publishedAt: (pkg) => {
      const key = packageVersionKey(pkg)
      const hit = published.get(key)
      if (hit) return hit
      const next = registryPublishedAt(pkg)
      published.set(key, next)
      return next
    },
  }
}
