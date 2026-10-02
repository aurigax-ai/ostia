import {
  EXTRA_KINDS,
  REDACT_TEXTS_MAX,
  REDACT_TEXT_MAX,
  type RedactionKindInfo,
  type RedactionResult,
  type SecretSpan,
  applyRedactions,
  compilePatterns,
  customSpans,
  extraSpans,
  parsePrivacySettings,
  unchanged,
} from '../shared/redaction'
import type { RedactText } from '../shared/redactionTargets'
import { libraryKinds, scanSecrets } from './secretScanner'

export type SecretScan = (text: string) => Promise<SecretSpan[]>

export interface Redactor {
  settingsKey: () => string
  kinds: () => RedactionKindInfo[]
  redact: (text: string) => Promise<RedactionResult>
  preview: (text: string) => Promise<RedactionResult>
  text: RedactText
}

export function createRedactor(
  readPrivacy: () => unknown,
  scan: SecretScan = scanSecrets,
): Redactor {
  let compiledFor = ''
  let compiled: RegExp[] = []
  const settings = () => parsePrivacySettings(readPrivacy()).redaction
  const patterns = (sources: string[]): RegExp[] => {
    const key = JSON.stringify(sources)
    if (key !== compiledFor) {
      compiled = compilePatterns(sources)
      compiledFor = key
    }
    return compiled
  }
  const detect = async (text: string, sources: string[]): Promise<RedactionResult> => {
    if (text === '') return unchanged(text)
    const spans = [
      ...(await scan(text)),
      ...extraSpans(text),
      ...customSpans(text, patterns(sources)),
    ]
    return applyRedactions(text, spans)
  }
  const redact = (text: string): Promise<RedactionResult> => {
    const current = settings()
    return current.enabled ? detect(text, current.patterns) : Promise.resolve(unchanged(text))
  }
  return {
    settingsKey: () => JSON.stringify(settings()),
    kinds: () => [
      ...libraryKinds(),
      ...EXTRA_KINDS.map((kind): RedactionKindInfo => ({ kind, source: 'pine', detects: [] })),
    ],
    redact,
    preview: (text) => detect(text, settings().patterns),
    text: async (text) => (await redact(text)).text,
  }
}

export function redactRequestedTexts(
  redactor: Redactor,
  raw: unknown,
): Promise<RedactionResult[]> | null {
  if (!Array.isArray(raw) || raw.length > REDACT_TEXTS_MAX) return null
  const texts: string[] = []
  let total = 0
  for (const item of raw) {
    if (typeof item !== 'string') return null
    total += item.length
    texts.push(item)
  }
  if (total > REDACT_TEXT_MAX) return null
  return Promise.all(texts.map((text) => redactor.redact(text)))
}

export function createScrollbackRedactor(
  redactor: Pick<Redactor, 'settingsKey' | 'text'>,
): (byPane: Record<string, string>) => Promise<Record<string, string>> {
  const seen = new Map<string, { raw: string; redacted: string }>()
  let seenWith = ''
  return async (byPane) => {
    const key = redactor.settingsKey()
    if (key !== seenWith) seen.clear()
    seenWith = key
    const out: Record<string, string> = {}
    for (const [paneId, raw] of Object.entries(byPane)) {
      const known = seen.get(paneId)
      const redacted = known?.raw === raw ? known.redacted : await redactor.text(raw)
      seen.set(paneId, { raw, redacted })
      out[paneId] = redacted
    }
    for (const paneId of [...seen.keys()]) if (!(paneId in byPane)) seen.delete(paneId)
    return out
  }
}
