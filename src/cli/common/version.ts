import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBuildInfo } from '../../shared/app/buildInfo'

export function buildVersionAt(cliDir: string): string | null {
  try {
    return (
      parseBuildInfo(JSON.parse(readFileSync(join(cliDir, '..', 'build-info.json'), 'utf8')))
        ?.version ?? null
    )
  } catch {
    return null
  }
}
