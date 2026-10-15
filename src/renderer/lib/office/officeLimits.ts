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
  parseMs: 20_000,
} as const

export type OfficeLimits = { readonly [K in keyof typeof OFFICE_LIMITS]: number }

export type OfficeProblem = 'too-large' | 'unzip-limit' | 'failed' | 'encrypted' | 'timeout'
