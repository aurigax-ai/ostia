import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolRun, runTool } from '@aurigax-ai/ostia-extension-sdk'
import {
  type BoardInfo,
  type CardDetail,
  type ProjectInfo,
  type TrellisBoard,
  type TrellisCard,
  type TrellisDaemonStatus,
  type TrellisError,
  type VaultEntry,
  type VaultEntrySummary,
  parseBoard,
  parseBoards,
  parseCard,
  parseCardDetail,
  parseDaemonStatus,
  parseError,
  parseObjectOutput,
  parseProjects,
  parseVaultEntry,
  parseVaultList,
} from './trellis'

export type CliResult<T> = { ok: true; value: T } | { ok: false; error: TrellisError }

export interface Scope {
  project: string
  board?: string
}

export interface NewCard extends Scope {
  title: string
  body: string
  column?: string
  priority?: string
}

export interface CliOptions {
  bin?: string
  timeoutMs?: number
}

const NOT_INSTALLED = 'not-installed'
export const TEXT_DIR_PREFIX = 'ostia-trellis-text-'
const TEXT_FILE_MODE = 0o600

function scopeArgs(scope: Scope): string[] {
  const args = ['--project', scope.project]
  if (scope.board) args.push('--board', scope.board)
  return args
}

export function failureOf(run: ToolRun): TrellisError {
  if (run.missing) return { code: NOT_INSTALLED, message: 'trellis is not on PATH' }
  if (run.timedOut) return { code: 'timeout', message: 'trellis did not answer in time' }
  const structured = parseError(run.stderr) ?? parseError(run.stdout)
  if (structured) return structured
  const line = run.stderr.trim().split('\n')[0] ?? ''
  return { code: 'failed', message: line || `trellis exited with ${run.code}` }
}

export class TrellisCli {
  private readonly bin: string
  private installed: boolean | null = null

  constructor(private readonly opts: CliOptions = {}) {
    this.bin = opts.bin ?? 'trellis'
  }

  async run(
    args: string[],
    opts: { cwd?: string; texts?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<CliResult<string>> {
    const texts = Object.entries(opts.texts ?? {})
    const dir = texts.length > 0 ? mkdtempSync(join(tmpdir(), TEXT_DIR_PREFIX)) : null
    const full = [...args]
    try {
      texts.forEach(([flag, value], i) => {
        const file = join(dir as string, `text-${i}`)
        writeFileSync(file, value, { mode: TEXT_FILE_MODE })
        full.push(`--${flag}`, `@${file}`)
      })
      const run = await runTool(this.bin, [...full, '--json'], {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs,
      })
      if (run.missing) this.installed = false
      if (run.code === 0) return { ok: true, value: run.stdout }
      return { ok: false, error: failureOf(run) }
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }

  private async parsed<T>(
    args: string[],
    parse: (stdout: string) => T | null,
    opts: { cwd?: string; texts?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<CliResult<T>> {
    const res = await this.run(args, opts)
    if (!res.ok) return res
    const value = parse(res.value)
    return value === null
      ? {
          ok: false,
          error: { code: 'unreadable', message: 'trellis printed output it cannot read' },
        }
      : { ok: true, value }
  }

  async isInstalled(): Promise<boolean> {
    if (this.installed !== null) return this.installed
    const res = await runTool(this.bin, ['version', '--json'], { timeoutMs: 5000 })
    this.installed = !res.missing && res.code === 0 && parseObjectOutput(res.stdout) !== null
    return this.installed
  }

  knownMissing(): boolean {
    return this.installed === false
  }

  board(scope: Scope): Promise<CliResult<TrellisBoard>> {
    return this.parsed(['board', 'show', ...scopeArgs(scope)], parseBoard)
  }

  boards(project: string): Promise<CliResult<BoardInfo[]>> {
    return this.parsed(['board', 'ls', '--project', project], parseBoards)
  }

  projects(): Promise<CliResult<ProjectInfo[]>> {
    return this.parsed(['project', 'ls'], parseProjects)
  }

  card(ref: string): Promise<CliResult<CardDetail>> {
    return this.parsed(['card', 'show', ref], parseCardDetail)
  }

  newCard(card: NewCard): Promise<CliResult<TrellisCard>> {
    const args = ['card', 'new', ...scopeArgs(card)]
    if (card.column) args.push(`--column=${card.column}`)
    if (card.priority) args.push(`--priority=${card.priority}`)
    const texts: Record<string, string> = { title: card.title }
    if (card.body) texts.body = card.body
    return this.parsed(args, parseCard, { texts })
  }

  move(ref: string, column: string): Promise<CliResult<TrellisCard>> {
    return this.parsed(['card', 'move', ref, `--column=${column}`], parseCard)
  }

  async comment(ref: string, body: string): Promise<CliResult<true>> {
    const res = await this.run(['card', 'comment', ref], { texts: { body } })
    return res.ok ? { ok: true, value: true } : res
  }

  claim(ref: string): Promise<CliResult<TrellisCard>> {
    return this.parsed(['card', 'claim', ref], parseCard)
  }

  async renew(ref: string): Promise<CliResult<true>> {
    const res = await this.run(['card', 'renew', ref])
    return res.ok ? { ok: true, value: true } : res
  }

  async release(ref: string): Promise<CliResult<true>> {
    const res = await this.run(['card', 'release', ref])
    return res.ok ? { ok: true, value: true } : res
  }

  vaultList(project: string): Promise<CliResult<VaultEntrySummary[]>> {
    return this.parsed(['vault', 'ls', '--project', project], parseVaultList)
  }

  vaultEntry(project: string, slug: string): Promise<CliResult<VaultEntry>> {
    return this.parsed(['vault', 'show', slug, '--project', project], parseVaultEntry)
  }

  daemonStatus(): Promise<CliResult<TrellisDaemonStatus>> {
    return this.parsed(['daemon', 'status'], parseDaemonStatus, { timeoutMs: 5000 })
  }

  init(dir: string): Promise<CliResult<Record<string, unknown>>> {
    return this.parsed(['init'], parseObjectOutput, { cwd: dir, timeoutMs: 30_000 })
  }
}
