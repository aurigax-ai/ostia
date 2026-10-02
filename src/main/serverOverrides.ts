import { constants, accessSync, statSync } from 'node:fs'
import {
  type LanguageServerOverride,
  type LanguageServerOverrideProblem,
  parseLanguageServerOverride,
  splitLanguageServerKey,
} from '../shared/languageServers'
import { isDangerousSegment } from '../shared/protoGuard'
import { loadJson, saveJson } from './jsonStore'

const MAX_OVERRIDES = 256

export function overrideFileProblem(path: string): LanguageServerOverrideProblem | null {
  let isFile: boolean
  try {
    isFile = statSync(path).isFile()
  } catch {
    return 'missing'
  }
  if (!isFile) return 'not-file'
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return 'not-executable'
  }
  return null
}

function sanitize(raw: unknown): Map<string, LanguageServerOverride> {
  const out = new Map<string, LanguageServerOverride>()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (out.size >= MAX_OVERRIDES) break
    if (isDangerousSegment(key) || splitLanguageServerKey(key) === null) continue
    const override = parseLanguageServerOverride(value)
    if (typeof override !== 'string') out.set(key, override)
  }
  return out
}

export class ServerOverrides {
  private overrides: Map<string, LanguageServerOverride>

  constructor(private readonly file: string) {
    this.overrides = sanitize(loadJson<unknown>(file, {}))
  }

  get(key: string): LanguageServerOverride | undefined {
    return this.overrides.get(key)
  }

  choose(key: string, raw: unknown): LanguageServerOverrideProblem | null {
    if (splitLanguageServerKey(key) === null) return 'unknown-server'
    if (raw === null) {
      if (this.overrides.delete(key)) this.save()
      return null
    }
    const override = parseLanguageServerOverride(raw)
    if (typeof override === 'string') return override
    const problem = overrideFileProblem(override.path)
    if (problem !== null) return problem
    this.overrides.set(key, override)
    this.save()
    return null
  }

  forgetExtension(extId: string): void {
    let removed = false
    for (const key of [...this.overrides.keys()]) {
      if (splitLanguageServerKey(key)?.extId !== extId) continue
      this.overrides.delete(key)
      removed = true
    }
    if (removed) this.save()
  }

  private save(): void {
    saveJson(this.file, Object.fromEntries(this.overrides))
  }
}
