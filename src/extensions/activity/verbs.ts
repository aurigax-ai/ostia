import { isAbsolute, resolve } from 'node:path'
import {
  type CommandHandler,
  cliArgs,
  type ExtensionCaller,
  type ExtensionResult,
  failure,
  ok,
  parseFlags,
} from '@aurigax-ai/ostia-extension-sdk'
import {
  type ActivityNote,
  type ActivityRecord,
  isOpenNeedsYou,
  isRecordId,
  NOTE_LINK_MAX,
  NOTE_TEXT_MAX,
  newRecordId,
} from './hookEvent'
import type { Journal } from './journal'
import { keepsOnDisk } from './recorder'

const USAGE = {
  add: 'add "<text>" [--needs-you] [--link <path|url>]',
  list: 'list [--needs-you] [--open] [--archived] [--since <time>] [--workspace <id>] [--json]',
  show: 'show <id> [--workspace <id>] [--json]',
  done: 'done <id>',
} as const

const SINCE_PATTERN = /^(\d{1,6})([mhd])$/
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

export interface VerbDeps {
  journal: Journal
  now: () => number
  redact: (texts: string[]) => Promise<string[] | null>
  workspaceKind: (workspaceId: string) => Promise<string | null>
  changed: () => void
}

export interface Entry {
  id: string
  time: string
  kind: 'note' | 'recap'
  pane: string
  text?: string
  agent?: string
  needsYou?: true
  done?: true
  link?: string
}

function entryOf(record: ActivityRecord): Entry | null {
  const base = { id: record.id, time: new Date(record.t).toISOString(), pane: record.pane }
  if (record.kind === 'note') {
    return {
      ...base,
      kind: 'note',
      text: record.text,
      ...(record.needsYou ? { needsYou: true as const } : {}),
      ...(record.doneAt !== undefined ? { done: true as const } : {}),
      ...(record.link ? { link: record.link } : {}),
    }
  }
  if (record.kind !== 'stop') return null
  return {
    ...base,
    kind: 'recap',
    agent: record.agent,
    ...(record.text ? { text: record.text } : {}),
  }
}

function markOf(entry: Entry): string {
  if (entry.kind === 'recap') return `recap ${entry.agent}`
  if (entry.needsYou) return entry.done ? 'needs-you done' : 'needs-you'
  return 'note'
}

function lineOf(entry: Entry): string {
  const text = (entry.text ?? '').split('\n')[0]
  return `${entry.id}\t${entry.time}\t${markOf(entry)}\t${text}`
}

function detailOf(entry: Entry): string {
  return [
    `id: ${entry.id}`,
    `time: ${entry.time}`,
    `kind: ${markOf(entry)}`,
    `pane: ${entry.pane}`,
    ...(entry.link ? [`link: ${entry.link}`] : []),
    '',
    entry.text ?? '',
  ].join('\n')
}

function withoutControls(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += (code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f ? ' ' : ch
  }
  return out
}

function unknownFlag(rest: string[]): string | undefined {
  return rest.find((arg) => arg.startsWith('--'))
}

function sinceOf(raw: string, now: number): number | null {
  const relative = SINCE_PATTERN.exec(raw)
  if (relative) return now - Number(relative[1]) * UNIT_MS[relative[2]]
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}

function linkOf(raw: string, caller: ExtensionCaller): string | null {
  if (raw === '' || raw.length > NOTE_LINK_MAX || withoutControls(raw) !== raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).toString()
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  const base = caller.cwd ?? caller.workDir
  if (isAbsolute(raw)) return raw
  return base ? resolve(base, raw) : null
}

function targetOf(
  caller: ExtensionCaller,
  workspace: string | undefined,
): { workspaceId: string } | ExtensionResult {
  if (!caller.workspaceId) return failure('not-available', 'only a workspace pane can do this')
  if (workspace === undefined || workspace === caller.workspaceId) {
    return { workspaceId: caller.workspaceId }
  }
  if (caller.sandboxed || !caller.capabilities.includes('all-workspaces')) {
    return failure('needs-elevation', 'all-workspaces')
  }
  return { workspaceId: workspace }
}

function usage(verb: keyof typeof USAGE, problem?: string): ExtensionResult {
  const text = `usage: ostia activity ${USAGE[verb]}`
  return failure('usage', problem ? `${problem}\n${text}` : text)
}

export function activityVerbs(deps: VerbDeps): Record<string, CommandHandler> {
  const add: CommandHandler = async (args, caller) => {
    if (caller.kind !== 'pane' || !caller.paneId || !caller.workspaceId) {
      return failure('not-available', 'only an agent’s pane can add to Activity')
    }
    const { flags, bools, rest } = parseFlags(cliArgs(args)?.argv ?? [], ['link'], ['needs-you'])
    const odd = unknownFlag(rest)
    if (odd) return usage('add', `unknown option ${odd}`)
    const text = withoutControls(rest.join(' ')).trim()
    if (text === '') return usage('add', 'the text is missing')
    if ([...text].length > NOTE_TEXT_MAX) {
      return failure('too-long', `the text is longer than ${NOTE_TEXT_MAX} characters`)
    }
    const link = flags.link === undefined ? undefined : linkOf(flags.link, caller)
    if (link === null) return usage('add', 'the link must be an http(s) URL or a path')
    const clean = await deps.redact(link ? [text, link] : [text]).catch(() => null)
    if (!clean?.[0]) {
      return failure('redaction-failed', 'the secret scan failed, so nothing was stored')
    }
    const workspaceId = caller.workspaceId
    const note: ActivityNote = {
      v: 2,
      t: deps.now(),
      id: newRecordId(),
      pane: caller.paneId,
      kind: 'note',
      text: clean[0],
      ...(bools.has('needs-you') ? { needsYou: true as const } : {}),
      ...(link && clean[1] ? { link: clean[1] } : {}),
    }
    const kind = await deps.workspaceKind(workspaceId).catch(() => null)
    deps.journal.append(workspaceId, note, keepsOnDisk(caller, kind))
    deps.changed()
    const stored = deps.journal.find(workspaceId, note.id)
    if (!stored) return failure('not-stored', 'the entry is not in Activity')
    return ok(stored.id, entryOf(stored))
  }

  const list: CommandHandler = async (args, caller) => {
    const { flags, bools, rest } = parseFlags(
      cliArgs(args)?.argv ?? [],
      ['since', 'workspace'],
      ['needs-you', 'open', 'archived', 'json'],
    )
    const odd = rest[0]
    if (odd) return usage('list', odd.startsWith('--') ? `unknown option ${odd}` : undefined)
    const target = targetOf(caller, flags.workspace)
    if ('ok' in target) return target
    const since = flags.since === undefined ? null : sinceOf(flags.since, deps.now())
    if (flags.since !== undefined && since === null) {
      return usage('list', 'since takes a time such as 2026-10-14T09:00 or 2h, 3d')
    }
    const records = bools.has('archived')
      ? deps.journal.archived(target.workspaceId)
      : deps.journal.events(target.workspaceId)
    const entries = records
      .filter((r) => since === null || r.t >= since)
      .filter((r) => !bools.has('open') || isOpenNeedsYou(r))
      .filter((r) => !bools.has('needs-you') || (r.kind === 'note' && r.needsYou === true))
      .map(entryOf)
      .filter((e): e is Entry => e !== null)
    if (bools.has('json')) return ok(undefined, entries)
    return ok(entries.length > 0 ? entries.map(lineOf).join('\n') : 'no entries')
  }

  const show: CommandHandler = async (args, caller) => {
    const { flags, bools, rest } = parseFlags(cliArgs(args)?.argv ?? [], ['workspace'], ['json'])
    const [id, extra] = rest
    if (!isRecordId(id) || extra !== undefined) return usage('show')
    const target = targetOf(caller, flags.workspace)
    if ('ok' in target) return target
    const found = deps.journal.find(target.workspaceId, id)
    const entry = found ? entryOf(found) : null
    if (!entry) return failure('unknown-entry', id)
    return bools.has('json') ? ok(undefined, entry) : ok(detailOf(entry), entry)
  }

  const done: CommandHandler = async (args, caller) => {
    const [id, extra] = cliArgs(args)?.argv ?? []
    if (!isRecordId(id) || extra !== undefined) return usage('done')
    if (caller.kind !== 'pane' || !caller.paneId || !caller.workspaceId) {
      return failure('not-available', 'the human marks items done in the Activity panel')
    }
    const found = deps.journal.find(caller.workspaceId, id)
    if (!found) return failure('unknown-entry', id)
    if (found.kind !== 'note' || !found.needsYou) {
      return failure('not-needs-you', 'only a needs-you item can be done')
    }
    if (found.pane !== caller.paneId) {
      return failure(
        'not-yours',
        'an agent marks only its own items done; the human marks the others in the Activity panel',
      )
    }
    if (found.doneAt === undefined) {
      deps.journal.markDone(caller.workspaceId, id, deps.now())
      deps.changed()
    }
    const after = deps.journal.find(caller.workspaceId, id)
    if (after?.kind !== 'note' || after.doneAt === undefined) {
      return failure('not-stored', 'the item is still open')
    }
    return ok(`${id} done`, entryOf(after))
  }

  return { add, list, show, done }
}
