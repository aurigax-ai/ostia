import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_FIELD_BYTES,
  addCard,
  boardPath,
  formatBoard,
  loadBoard,
  removeCard,
  sanitizePatch,
  updateCard,
} from './board'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pine-kanban-'))
  path = boardPath(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('kanban board', () => {
  it('stores the board under <workDir>/.pine and expands ~ to the home directory', () => {
    expect(path).toBe(join(dir, '.pine', 'board.json'))
    expect(boardPath('~')).toBe(join(homedir(), '.pine', 'board.json'))
  })

  it('adds cards with sequential ids into todo by default', () => {
    expect(addCard(path, { title: 'a' })).toMatchObject({ card: { id: 'card-1', column: 'todo' } })
    expect(addCard(path, { title: 'b', column: 'doing' })).toMatchObject({
      card: { id: 'card-2', column: 'doing' },
    })
    expect(loadBoard(path).cards.map((c) => c.id)).toEqual(['card-1', 'card-2'])
  })

  it('rejects unknown columns, oversized fields and missing titles', () => {
    expect(addCard(path, { title: 'a', column: 'later' })).toEqual({
      ok: false,
      error: 'unknown-column',
    })
    expect(addCard(path, { title: 'x'.repeat(MAX_FIELD_BYTES + 1) })).toEqual({
      ok: false,
      error: 'too-large',
    })
    expect(addCard(path, { title: '' })).toMatchObject({ ok: false, error: 'missing-title' })
  })

  it('updates, moves and removes cards, reporting not-found for unknown ids', () => {
    addCard(path, { title: 'a' })
    expect(updateCard(path, 'card-1', { column: 'done', assignee: 'codex' })).toEqual({ ok: true })
    expect(loadBoard(path).cards[0]).toMatchObject({ column: 'done', assignee: 'codex' })
    expect(updateCard(path, 'card-9', { title: 'x' })).toEqual({ ok: false, error: 'not-found' })
    expect(removeCard(path, 'card-1')).toEqual({ ok: true })
    expect(removeCard(path, 'card-1')).toEqual({ ok: false, error: 'not-found' })
  })

  it('keeps only known string fields from an untrusted patch', () => {
    expect(sanitizePatch({ title: 't', column: 3, id: 'card-7', assignee: 'me' })).toEqual({
      title: 't',
      assignee: 'me',
    })
    expect(sanitizePatch(null)).toEqual({})
  })

  it('formats the board the way `pine kanban ls` always printed it', () => {
    addCard(path, { title: 'a' })
    updateCard(path, 'card-1', { assignee: 'claude' })
    expect(formatBoard(loadBoard(path))).toBe(
      '# Todo (todo)\n  card-1\ta @claude\n# Doing (doing)\n  (empty)\n# Done (done)\n  (empty)',
    )
  })
})
