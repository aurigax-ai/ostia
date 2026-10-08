import type { ChatContextItem } from '@shared/assist'
import { type Dict, fmt } from '@shared/dict'
import {
  REDACT_TEXTS_MAX,
  REDACT_TEXT_MAX,
  type RedactionResult,
  countPlaceholders,
  unchanged,
} from '@shared/redaction'

function batches(texts: readonly string[]): string[][] {
  const out: string[][] = []
  let batch: string[] = []
  let size = 0
  for (const text of texts) {
    if (
      batch.length === REDACT_TEXTS_MAX ||
      (batch.length > 0 && size + text.length > REDACT_TEXT_MAX)
    ) {
      out.push(batch)
      batch = []
      size = 0
    }
    batch.push(text)
    size += text.length
  }
  if (batch.length > 0) out.push(batch)
  return out
}

export async function redactTexts(texts: readonly string[]): Promise<RedactionResult[]> {
  const out: RedactionResult[] = []
  for (const batch of batches(texts)) {
    const results = await window.ostia.privacy.redact(batch).catch(() => [])
    out.push(...(results.length === batch.length ? results : batch.map(unchanged)))
  }
  return out
}

export async function redactedCount(texts: readonly string[]): Promise<number> {
  const filled = texts.filter((text) => text !== '')
  if (filled.length === 0) return 0
  return (await redactTexts(filled)).reduce((sum, result) => sum + result.count, 0)
}

export async function redactOutgoing(
  question: string,
  context: readonly ChatContextItem[],
): Promise<{ question: string; context: ChatContextItem[] }> {
  const [asked, ...items] = await redactTexts([question, ...context.map((item) => item.text)])
  return {
    question: asked.text.trim() ? asked.text : question,
    context: context.map((item, i) => ({ ...item, text: items[i].text })),
  }
}

function collect(value: unknown, into: string[], depth = 0): void {
  if (typeof value === 'string') into.push(value)
  else if (depth > 8 || typeof value !== 'object' || value === null) return
  else for (const item of Object.values(value)) collect(item, into, depth + 1)
}

function rebuild(value: unknown, next: () => string, depth = 0): unknown {
  if (typeof value === 'string') return next()
  if (depth > 8 || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => rebuild(item, next, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, rebuild(item, next, depth + 1)]),
  )
}

export async function redactToolOutput(output: unknown): Promise<unknown> {
  const texts: string[] = []
  collect(output, texts)
  if (texts.length === 0) return output
  const results = await redactTexts(texts)
  if (results.every((result) => result.count === 0)) return output
  let at = 0
  return rebuild(output, () => results[at++].text)
}

export function redactionsIn(text: string, context: readonly ChatContextItem[]): number {
  return context.reduce((sum, item) => sum + countPlaceholders(item.text), countPlaceholders(text))
}

export function redactedCountLabel(d: Dict, count: number): string {
  return count === 1 ? d.privacy.redactedOne : fmt(d.privacy.redactedMany, { count })
}
