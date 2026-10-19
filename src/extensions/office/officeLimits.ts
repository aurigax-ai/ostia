import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { formatMegabytes } from '@aurigax-ai/ostia-extension-sdk/viewer'

const MIB = 1024 * 1024

export const OFFICE_LIMITS = {
  fileBytes: 25 * MIB,
  sheets: 256,
  rows: 100_000,
  columns: 1_000,
  cells: 2_000_000,
  xmlDepth: 256,
  slides: 2_000,
  outlineChars: 2_000_000,
  parseMs: 20_000,
} as const

export type OfficeLimits = { readonly [K in keyof typeof OFFICE_LIMITS]: number }

export type OfficeProblem = 'too-large' | 'failed' | 'encrypted' | 'timeout'

export class GuardStop extends Error {
  constructor(readonly problem: OfficeProblem) {
    super(problem)
  }
}

export function problemOf(error: unknown): OfficeProblem {
  if (error instanceof GuardStop) return error.problem
  return error instanceof Error && /encrypted|password/i.test(error.message)
    ? 'encrypted'
    : 'failed'
}

export function officeProblemText(t: Translate, problem: OfficeProblem, locale: string): string {
  return t(problem, { limit: formatMegabytes(OFFICE_LIMITS.fileBytes, locale) })
}
