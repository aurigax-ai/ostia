export interface Rate {
  sessions: number
  restated: number
  rate: number
  low: number
  high: number
}

export interface ScoreRow {
  id: string
  applied: number
  lastApplied: number | null
  restated: number
  before: Rate
  after: Rate
  enough: boolean
  holdout: { held: Rate; given: Rate } | null
}
