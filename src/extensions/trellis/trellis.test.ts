import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cardPath,
  cardRef,
  countCards,
  findProject,
  isAppPath,
  needsUser,
  parseCards,
  parseColumns,
  parseDaemonStatus,
  parseError,
  parseEventLine,
  parseMarker,
  parseUiInfo,
  projectOfRef,
  projectPath,
} from './trellis'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../../test/fixtures/tools/trellis', name), 'utf8')

describe('trellis CLI output parsing', () => {
  it('reads the running UI address from trellis ui --json', () => {
    expect(parseUiInfo(fixture('ui.json'))).toEqual({
      url: 'http://127.0.0.1:7788/?token=TESTTOKEN',
      started: false,
    })
  })

  it('rejects a UI address that is not loopback http', () => {
    expect(parseUiInfo('{"url":"http://10.0.0.5:7788/"}')).toBeNull()
    expect(parseUiInfo('{"url":"https://127.0.0.1:7788/"}')).toBeNull()
    expect(parseUiInfo('not json')).toBeNull()
  })

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

  it('tolerates the update notice trellis appends after its JSON', () => {
    expect(fixture('version.json')).toContain('new Trellis release')
    expect(
      parseUiInfo(`${fixture('ui.json').trim()}\nnew Trellis release available`),
    ).not.toBeNull()
  })

  it('reads the structured error trellis prints on failure', () => {
    expect(parseError(fixture('error-project-not-found.json'))).toEqual({
      code: 'project_not_found',
      message: 'no project NOPE',
      fix: 'trellis card ls --all-projects   # known: ALPHA, DEMO',
    })
    expect(parseError(fixture('ui.json'))).toBeNull()
  })

  it('reads cards with their claims', () => {
    const cards = parseCards(fixture('cards.json'))
    expect(cards).toHaveLength(6)
    expect(cards?.[0]).toEqual({
      ref: 'DEMO-1',
      title: 'Card 1',
      column: 'review',
      claimedBy: 'agent:b4f918133cdb93fa1ce15681360c3cec',
      claimUntil: 1790323096200,
    })
    expect(cards?.[1].claimedBy).toBeUndefined()
  })

  it('reads columns and which one is done', () => {
    expect(parseColumns(fixture('columns.json'))).toEqual([
      { name: 'backlog', isDone: false },
      { name: 'in-progress', isDone: false },
      { name: 'review', isDone: false },
      { name: 'done', isDone: true },
    ])
  })

  it('counts open cards and live claims, not done cards or expired claims', () => {
    const cards = parseCards(fixture('cards.json')) ?? []
    const columns = parseColumns(fixture('columns.json')) ?? []
    expect(countCards(cards, columns, 1790323096200 - 1)).toEqual({ open: 4, claimed: 1 })
    expect(countCards(cards, columns, 1790323096200 + 1)).toEqual({ open: 4, claimed: 0 })
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

  it('builds UI paths and only allows app paths as proxy entries', () => {
    expect(projectPath({ project: 'SHOP', marker: '' })).toBe('/p/SHOP')
    expect(projectPath({ project: 'SHOP', board: 'ops', marker: '' })).toBe('/p/SHOP/b/ops')
    expect(projectPath(null)).toBe('/')
    expect(isAppPath('/p/SHOP/b/ops')).toBe(true)
    expect(isAppPath('//evil.example')).toBe(false)
    expect(isAppPath('/api/p/SHOP')).toBe(false)
  })

  it('builds a card deep link from its ref and allows it as a proxy entry', () => {
    expect(cardRef(' shop-12 ')).toBe('SHOP-12')
    expect(cardRef('MY-APP-3')).toBe('MY-APP-3')
    expect(cardRef('shop')).toBeNull()
    expect(cardRef('SHOP-12/../x')).toBeNull()
    expect(cardPath('shop-12')).toBe('/p/SHOP/card/SHOP-12')
    expect(cardPath('MY-APP-3')).toBe('/p/MY-APP/card/MY-APP-3')
    expect(cardPath('nope')).toBeNull()
    expect(isAppPath('/p/SHOP/card/SHOP-12')).toBe(true)
    expect(isAppPath('/p/SHOP/card/SHOP-12?x=1')).toBe(false)
    expect(isAppPath('/p/SHOP/card/../api')).toBe(false)
  })
})
