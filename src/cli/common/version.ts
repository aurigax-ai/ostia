import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseBuildInfo } from '../../shared/app/buildInfo'

export function buildInfoPathAt(cliDir: string): string {
  const asar = dirname(dirname(cliDir))
  if (basename(asar) === 'app.asar') return join(dirname(asar), 'build-info.json')
  return join(cliDir, '..', 'build-info.json')
}

export function buildVersionAt(cliDir: string): string | null {
  try {
    return (
      parseBuildInfo(JSON.parse(readFileSync(buildInfoPathAt(cliDir), 'utf8')))?.version ?? null
    )
  } catch {
    return null
  }
}
