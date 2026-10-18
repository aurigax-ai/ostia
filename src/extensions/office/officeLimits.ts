import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { formatMegabytes } from '@aurigax-ai/ostia-extension-sdk/viewer'

const MIB = 1024 * 1024

export const OFFICE_LIMITS = {
  fileBytes: 25 * MIB,
  inflatedBytes: 128 * MIB,
  entries: 10_000,
  entryRatio: 200,
  ratioFloorBytes: MIB,
  sheets: 256,
  rows: 100_000,
  columns: 1_000,
  cells: 2_000_000,
  sheetNodes: 4_500_000,
  documentNodes: 200_000,
  presentationNodes: 1_000_000,
  xmlDepth: 256,
  parseMs: 20_000,
} as const

export type OfficeLimits = { readonly [K in keyof typeof OFFICE_LIMITS]: number }

export type OfficeProblem =
  | 'too-large'
  | 'unzip-limit'
  | 'cells-limit'
  | 'nodes-limit'
  | 'depth-limit'
  | 'failed'
  | 'encrypted'
  | 'timeout'

export class GuardStop extends Error {
  constructor(readonly problem: OfficeProblem) {
    super(problem)
  }
}

export function officeProblemText(t: Translate, problem: OfficeProblem, locale: string): string {
  const limit = problem === 'too-large' ? OFFICE_LIMITS.fileBytes : OFFICE_LIMITS.inflatedBytes
  return t(problem, {
    limit: formatMegabytes(limit, locale),
    cells: OFFICE_LIMITS.cells.toLocaleString(locale),
  })
}
