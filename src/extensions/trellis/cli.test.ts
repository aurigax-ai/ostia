import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEXT_DIR_PREFIX, TrellisCli, failureOf } from './cli'
import { type FakeTrellis, fakeTrellis } from './testFake'

function textDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(TEXT_DIR_PREFIX))
}

describe('TrellisCli against the fake trellis', () => {
  let fake: FakeTrellis
  let cli: TrellisCli

  beforeEach(() => {
    fake = fakeTrellis()
    cli = new TrellisCli()
  })
  afterEach(() => fake.restore())

  it('reads the board of a project with one argv call', async () => {
    const res = await cli.board({ project: 'DEMO' })
    expect(res.ok && res.value.columns.map((c) => c.name)).toEqual([
      'backlog',
      'in-progress',
      'review',
      'done',
    ])
    expect(fake.calls()).toEqual(['board show --project DEMO --json'])
  })

  it('names the board when the marker names one', async () => {
    await cli.board({ project: 'DEMO', board: 'demo' })
    expect(fake.calls()).toEqual(['board show --project DEMO --board demo --json'])
  })

  it('reports an unknown project from the JSON error on stderr', async () => {
    const res = await cli.board({ project: 'NOPE' })
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'project_not_found',
        message: 'no project NOPE',
        fix: 'trellis card ls --all-projects   # known: DEMO',
      },
    })
  })

  it('reports a missing card and a missing entry by their codes', async () => {
    const card = await cli.card('DEMO-99')
    expect(!card.ok && card.error.code).toBe('card_not_found')
    const entry = await cli.vaultEntry('DEMO', 'nope')
    expect(!entry.ok && entry.error.code).toBe('entry_not_found')
  })

  it('turns a plain-text usage error into a failure with its first line', () => {
    expect(
      failureOf({
        code: 1,
        stdout: '',
        stderr: 'error: unknown flag: --bogus\n',
        missing: false,
        timedOut: false,
      }),
    ).toEqual({ code: 'failed', message: 'error: unknown flag: --bogus' })
    expect(
      failureOf({ code: null, stdout: '', stderr: '', missing: false, timedOut: true }).code,
    ).toBe('timeout')
  })

  it('knows trellis is installed although version prints a notice after its JSON', async () => {
    expect(await cli.isInstalled()).toBe(true)
    expect(cli.knownMissing()).toBe(false)
  })

  it('reports not-installed when the binary is not on PATH', async () => {
    const missing = new TrellisCli({ bin: join(fake.root, 'no-such-trellis') })
    expect(await missing.isInstalled()).toBe(false)
    const res = await missing.board({ project: 'DEMO' })
    expect(!res.ok && res.error.code).toBe('not-installed')
    expect(missing.knownMissing()).toBe(true)
  })

  it('passes free text through private files so a leading @ or - stays text', async () => {
    const secret = join(fake.root, 'secret.txt')
    writeFileSync(secret, 'TOP SECRET')
    const savedTmp = process.env.TMPDIR
    process.env.TMPDIR = fake.root
    expect(tmpdir()).toBe(fake.root)
    const res = await cli.newCard({
      project: 'DEMO',
      title: `@${secret}`,
      body: '-',
      column: 'backlog',
      priority: 'high',
    })
    expect(res.ok && res.value.title).toBe(`@${secret}`)
    const call = fake.calls()[0]
    expect(call).toMatch(
      /^card new --project DEMO --column=backlog --priority=high --title @\S+text-0 --body @\S+text-1 --json$/,
    )
    expect(call).not.toContain(secret)
    const created = fake.state().board.columns[0].cards.at(-1) as { title?: string; body?: string }
    expect(created.title).toBe(`@${secret}`)
    expect(created.body).toBe('-')
    expect(textDirs(fake.root)).toEqual([])
    if (savedTmp === undefined) Reflect.deleteProperty(process.env, 'TMPDIR')
    else process.env.TMPDIR = savedTmp
  })

  it('moves a card with the column as one flag value', async () => {
    const res = await cli.move('DEMO-3', 'in progress; rm -rf')
    expect(!res.ok && res.error.code).toBe('column_not_found')
    const moved = await cli.move('DEMO-3', 'review')
    expect(moved.ok && moved.value.column).toBe('review')
    expect(fake.calls().at(-1)).toBe('card move DEMO-3 --column=review --json')
  })

  it('comments, claims, renews and releases as the human actor', async () => {
    expect((await cli.comment('DEMO-3', 'Looks good.')).ok).toBe(true)
    expect(fake.state().comments['DEMO-3']).toMatchObject([
      { actor: 'human:pine', body: 'Looks good.' },
    ])
    const claimed = await cli.claim('DEMO-3')
    expect(claimed.ok && claimed.value.claimedBy).toBe('human:pine')
    expect((await cli.renew('DEMO-3')).ok).toBe(true)
    expect((await cli.release('DEMO-3')).ok).toBe(true)
    const again = await cli.release('DEMO-3')
    expect(!again.ok && again.error.code).toBe('not_yours')
  })

  it('reports contention when another actor holds the claim', async () => {
    const res = await cli.claim('DEMO-1')
    expect(!res.ok && res.error.code).toBe('contention')
  })

  it('lists and reads vault entries', async () => {
    const list = await cli.vaultList('DEMO')
    expect(list.ok && list.value.map((e) => e.slug)).toEqual([
      'ops/deploy/rollback-a-deploy',
      'database-concurrency',
    ])
    const entry = await cli.vaultEntry('DEMO', 'ops/deploy/rollback-a-deploy')
    expect(entry.ok && entry.value.title).toBe('Rollback a deploy')
  })

  it('reads the daemon address only while a daemon runs', async () => {
    const stopped = await cli.daemonStatus()
    expect(stopped.ok && stopped.value).toEqual({ running: false, url: null })
    writeFileSync(join(fake.dir, 'daemon-up'), '')
    const running = await cli.daemonStatus()
    expect(running.ok && running.value.url).toBe('http://127.0.0.1:7788/?token=TESTTOKEN')
    expect(existsSync(join(fake.dir, 'serving'))).toBe(false)
  })
})
