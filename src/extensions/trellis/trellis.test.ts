import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  boardSlug,
  cardPath,
  cardRef,
  cardTitle,
  columnName,
  countBoard,
  entrySlug,
  findProject,
  longText,
  needsUser,
  panelTarget,
  parseBoard,
  parseBoards,
  parseCard,
  parseCardDetail,
  parseCardThread,
  parseDaemonStatus,
  parseError,
  parseEventLine,
  parseMarker,
  parseObjectOutput,
  parseProjects,
  parseVaultEntry,
  parseVaultList,
  priority,
  projectKey,
  projectOfRef,
} from './trellis'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../../test/fixtures/tools/trellis', name), 'utf8')

const LIVE_AT = 1790892187647 - 1

describe('trellis CLI output parsing', () => {
  it('reads daemon status in both states', () => {
    expect(parseDaemonStatus(fixture('daemon-running.json'))).toEqual({
      running: true,
      url: 'http://127.0.0.1:7788/?token=TESTTOKEN',
    })
    expect(parseDaemonStatus(fixture('daemon-stopped.json'))).toEqual({
      running: false,
      url: null,
    })
  })

  it('drops a daemon address that is not loopback http', () => {
    expect(parseDaemonStatus('{"running":true,"url":"http://10.0.0.5:7788/?token=x"}')).toEqual({
      running: true,
      url: null,
    })
    expect(parseDaemonStatus('{"running":true,"url":"https://127.0.0.1:7788/"}')?.url).toBeNull()
  })

  it('reads the first line when trellis appends its update notice after the JSON', () => {
    expect(fixture('version.json')).toContain('new Trellis release')
    expect(parseObjectOutput(fixture('version.json'))).toMatchObject({ version: 'v0.0.7' })
    expect(parseObjectOutput('not json')).toBeNull()
  })

  it('reads the structured error trellis prints on stderr', () => {
    expect(parseError(fixture('error-project-not-found.json'))).toEqual({
      code: 'project_not_found',
      message: 'no project NOPE',
      fix: 'trellis card ls --all-projects   # known: DEMO',
    })
    expect(parseError(fixture('error-contention.json'))?.code).toBe('contention')
    expect(parseError(fixture('error-usage.txt'))).toBeNull()
    expect(parseError(fixture('board.json'))).toBeNull()
  })

  it('reads a board as columns of cards with labels, priority and claims', () => {
    const board = parseBoard(fixture('board.json'))
    expect(board).toMatchObject({ project: 'DEMO', board: 'demo', slug: 'demo' })
    expect(board?.columns.map((c) => [c.name, c.done, c.cards.map((x) => x.ref)])).toEqual([
      ['backlog', false, ['DEMO-5', 'DEMO-3']],
      ['in-progress', false, ['DEMO-1']],
      ['review', false, ['DEMO-2']],
      ['done', true, ['DEMO-4']],
    ])
    expect(board?.columns[1].cards[0]).toEqual({
      ref: 'DEMO-1',
      title: 'Checkout fails on an empty cart',
      column: 'in-progress',
      priority: 'high',
      labels: ['bug'],
      version: 3,
      updatedAt: 1790890387653,
      claimedBy: 'agent:5f3c9a1e7b2d4c6f8a0b1c2d3e4f5a6b',
      claimUntil: 1790892187647,
    })
    expect(parseBoard('{"cards":[]}')).toBeNull()
  })

  it('counts open cards and live claims, not done cards or expired claims', () => {
    const board = parseBoard(fixture('board.json'))
    if (!board) throw new Error('no board')
    expect(countBoard(board, LIVE_AT)).toEqual({ open: 4, claimed: 2 })
    expect(countBoard(board, LIVE_AT + 60_000)).toEqual({ open: 4, claimed: 0 })
  })

  it('reads boards and projects', () => {
    expect(parseBoards(fixture('boards.json'))).toEqual([
      { name: 'demo', slug: 'demo', isDefault: true, cardCount: 5 },
    ])
    expect(parseProjects(fixture('projects.json'))).toEqual([{ key: 'DEMO', name: 'DEMO' }])
    expect(parseProjects('{"projects":[{"key":"../x"}]}')).toEqual([])
  })

  it('reads a card with its body and relations', () => {
    const card = parseCardDetail(fixture('card-DEMO-3.json'))
    expect(card).toMatchObject({ ref: 'DEMO-3', body: '', priority: 'low', labels: ['docs'] })
    expect(card?.relations).toEqual([
      {
        rel: 'blocked_by',
        ref: 'DEMO-1',
        title: 'Checkout fails on an empty cart',
        column: 'in-progress',
        done: false,
      },
    ])
    expect(parseCardDetail(fixture('card-DEMO-2.json'))?.body).toContain(
      '<script>alert(1)</script>',
    )
  })

  it('reads what the write commands print', () => {
    expect(parseCard(fixture('card-new.json'))).toMatchObject({ ref: 'DEMO-6', column: 'backlog' })
    expect(parseCard(fixture('card-move.json'))).toMatchObject({
      ref: 'DEMO-5',
      column: 'in-progress',
    })
    expect(parseCard(fixture('card-claim.json'))?.claimedBy).toBe('human:pine')
    expect(parseCard(fixture('card-renew.json'))).toBeNull()
  })

  it('reads comments and activity from the daemon card answer', () => {
    const thread = parseCardThread(fixture('http-card-DEMO-1.json'))
    expect(thread?.comments).toEqual([
      {
        id: '01a0f962-a8cb-7af5-af56-8492f1dc3d9f',
        actor: 'agent:5f3c9a1e7b2d4c6f8a0b1c2d3e4f5a6b',
        body: 'Reproduced on **main**; the cart total is `null`.\n',
        createdAt: 1790890387659,
      },
    ])
    expect(thread?.activity.find((a) => a.action === 'moved')).toMatchObject({
      field: 'column',
      old: 'backlog',
      new: 'in-progress',
    })
    expect(parseCardThread('{"error":"no card"}')).toBeNull()
  })

  it('reads vault entries and one entry with its body and sources', () => {
    const list = parseVaultList(fixture('vault-ls.json'))
    expect(list?.map((e) => [e.slug, e.template, e.private])).toEqual([
      ['ops/deploy/rollback-a-deploy', 'runbook', false],
      ['database-concurrency', 'decision', false],
    ])
    const entry = parseVaultEntry(fixture('vault-database-concurrency.json'))
    expect(entry).toMatchObject({
      slug: 'database-concurrency',
      title: 'Database concurrency',
      summary: 'WAL mode so readers never block checkout',
      tags: ['db'],
      sources: ['/DEMO/cards/DEMO-1'],
    })
    expect(entry?.body.startsWith('## Context')).toBe(true)
  })
})

describe('panel input checks', () => {
  it('accepts only card refs, project keys and slugs trellis could have made', () => {
    expect(cardRef(' shop-12 ')).toBe('SHOP-12')
    expect(cardRef('MY-APP-3')).toBe('MY-APP-3')
    expect(cardRef('shop')).toBeNull()
    expect(cardRef('SHOP-12/../x')).toBeNull()
    expect(cardRef('--help')).toBeNull()
    expect(cardRef(12)).toBeNull()
    expect(projectKey('DEMO')).toBe('DEMO')
    expect(projectKey('GLOBAL')).toBeNull()
    expect(projectKey('--board')).toBeNull()
    expect(boardSlug('main-board')).toBe('main-board')
    expect(boardSlug('Main')).toBeNull()
    expect(entrySlug('ops/deploy/rollback-a-deploy')).toBe('ops/deploy/rollback-a-deploy')
    expect(entrySlug('../secret')).toBeNull()
    expect(entrySlug('-x')).toBeNull()
    expect(entrySlug('/DEMO/vault/x')).toBeNull()
  })

  it('keeps titles on one line and refuses oversized or control text', () => {
    expect(cardTitle('  Fix\n the   cart ')).toBe('Fix the cart')
    expect(cardTitle('   ')).toBeNull()
    expect(cardTitle('x'.repeat(301))).toBeNull()
    expect(columnName(' in-progress ')).toBe('in-progress')
    expect(columnName('a\u0000b')).toBeNull()
    expect(columnName('')).toBeNull()
    expect(longText('a\r\nb')).toBe('a\nb')
    expect(longText('x'.repeat(64 * 1024 + 1))).toBeNull()
    expect(priority('high')).toBe('high')
    expect(priority('highest')).toBeNull()
  })

  it('maps panel paths to a view and a card', () => {
    expect(cardPath('shop-12')).toBe('/card/SHOP-12')
    expect(cardPath('nope')).toBeNull()
    expect(panelTarget(undefined)).toEqual({ view: 'board' })
    expect(panelTarget('/board')).toEqual({ view: 'board' })
    expect(panelTarget('/vault')).toEqual({ view: 'vault' })
    expect(panelTarget('/card/SHOP-12')).toEqual({ view: 'board', card: 'SHOP-12' })
    expect(panelTarget('/card/../x')).toEqual({ view: 'board' })
    expect(panelTarget('/p/SHOP/card/SHOP-12')).toEqual({ view: 'board' })
  })
})

describe('trellis events', () => {
  const lines = (): string[] => fixture('events.jsonl').trim().split('\n')

  it('parses event lines and the gap marker', () => {
    const [gap, first] = lines().map(parseEventLine)
    expect(gap).toEqual({ gap: true })
    expect(first).toMatchObject({
      seq: 46,
      entity: 'card',
      ref: 'TRELLIS-13',
      action: 'moved',
      field: 'column',
      old: 'backlog',
      new: 'in-progress',
    })
    expect(parseEventLine('garbage')).toBeNull()
    expect(parseEventLine('{"seq":"x"}')).toBeNull()
  })

  it('flags only agent moves into a review column', () => {
    const flagged = lines()
      .map(parseEventLine)
      .filter((e): e is Exclude<ReturnType<typeof parseEventLine>, null | { gap: true }> =>
        Boolean(e && !('gap' in e)),
      )
      .filter((e) => needsUser(e))
      .map((e) => e.seq)
    expect(flagged).toEqual([49, 54, 56])
  })

  it('flags an agent move into a blocked column as blocked', () => {
    expect(
      needsUser({
        seq: 1,
        ts: 0,
        actor: 'agent:x',
        entity: 'card',
        ref: 'A-1',
        title: 't',
        action: 'moved',
        field: 'column',
        new: 'Blocked',
      }),
    ).toEqual({ kind: 'blocked', column: 'Blocked' })
  })

  it('flags only the kinds the human chose to be told about', () => {
    const move = (column: string) => ({
      seq: 1,
      ts: 0,
      actor: 'agent:x',
      entity: 'card',
      ref: 'A-1',
      title: 't',
      action: 'moved',
      field: 'column',
      new: column,
    })
    expect(needsUser(move('Blocked'), { review: true, blocked: false })).toBeNull()
    expect(needsUser(move('review'), { review: false, blocked: true })).toBeNull()
    expect(needsUser(move('review'), { review: true, blocked: false })).toEqual({
      kind: 'review',
      column: 'review',
    })
  })

  it('maps a card ref to its project key', () => {
    expect(projectOfRef('TRELLIS-13')).toBe('TRELLIS')
    expect(projectOfRef('TELUS-CHR-12')).toBe('TELUS-CHR')
    expect(projectOfRef('claimrx-demo')).toBeNull()
    expect(projectOfRef('/DEMO/vault/ops/rollback')).toBe('DEMO')
    expect(projectOfRef('/GLOBAL/vault/x')).toBeNull()
  })
})

describe('trellis project markers', () => {
  let root: string
  let home: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pine-trellis-'))
    home = join(root, 'home')
    mkdirSync(home)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('parses both marker shapes and rejects others', () => {
    expect(parseMarker('/KEEPER\n')).toEqual({ project: 'KEEPER' })
    expect(parseMarker('/demo/boards/main-board')).toEqual({ project: 'DEMO', board: 'main-board' })
    expect(parseMarker('KEEPER')).toBeNull()
    expect(parseMarker('/GLOBAL')).toBeNull()
    expect(parseMarker('/A/boards/Bad_Slug')).toBeNull()
  })

  it('finds the nearest marker above a directory', () => {
    const repo = join(home, 'code', 'shop')
    mkdirSync(join(repo, 'src', 'api'), { recursive: true })
    writeFileSync(join(repo, '.trellis'), '/SHOP\n')
    expect(findProject(join(repo, 'src', 'api'), home)).toEqual({
      project: 'SHOP',
      marker: join(repo, '.trellis'),
    })
  })

  it('stops at a repository root and never reads the home directory', () => {
    writeFileSync(join(home, '.trellis'), '/HOME\n')
    const outer = join(home, 'outer')
    const repo = join(outer, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(outer, '.trellis'), '/OUTER\n')
    expect(findProject(repo, home)).toBeNull()
    expect(findProject(home, home)).toBeNull()
    expect(findProject(join(root, 'missing'), home)).toBeNull()
  })
})
