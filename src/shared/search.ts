export interface SearchRequest {
  root: string
  text: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  includeIgnored: boolean
}

export interface LineMatch {
  line: number
  column: number
  text: string
  ranges: [number, number][]
}

export interface FileMatches {
  path: string
  matches: LineMatch[]
}

export interface SearchNameHit {
  path: string
  dir: boolean
  positions: number[]
}

export interface SearchPdf {
  path: string
  size: number
  mtimeMs: number
}

export interface SearchResults {
  root: string
  names: SearchNameHit[]
  files: FileMatches[]
  pdfs: SearchPdf[]
  matches: number
  truncated: boolean
}

export type SearchError =
  | 'outside-roots'
  | 'invalid-pattern'
  | 'rg-missing'
  | 'failed'
  | 'cancelled'

export type SearchOutcome =
  | { ok: true; results: SearchResults }
  | { ok: false; error: SearchError; message: string }

export interface SearchApi {
  run: (req: SearchRequest) => Promise<SearchOutcome>
}
