import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseScope } from './scope'

export interface ViewState {
  chosen: Record<string, string[]>
}

export const MAX_REMEMBERED_REPOS = 200

export function parseViewState(raw: unknown): ViewState {
  const state: ViewState = { chosen: {} }
  if (typeof raw !== 'object' || raw === null) return state
  const chosen = (raw as { chosen?: unknown }).chosen
  if (typeof chosen !== 'object' || chosen === null) return state
  for (const [root, refs] of Object.entries(chosen).slice(-MAX_REMEMBERED_REPOS)) {
    const scope = parseScope({ kind: 'chosen', refs })
    if (scope?.kind === 'chosen' && root.startsWith('/')) state.chosen[root] = scope.refs
  }
  return state
}

export class ViewStateStore {
  private state: ViewState

  constructor(private readonly file: string | null) {
    this.state = parseViewState(file ? readJson(file) : null)
  }

  chosenFor(root: string): string[] | null {
    return this.state.chosen[root] ?? null
  }

  setChosen(root: string, refs: string[] | null): void {
    const { [root]: _old, ...rest } = this.state.chosen
    const chosen = refs && refs.length > 0 ? { ...rest, [root]: refs } : rest
    this.state.chosen = Object.fromEntries(Object.entries(chosen).slice(-MAX_REMEMBERED_REPOS))
    this.save()
  }

  private save(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
