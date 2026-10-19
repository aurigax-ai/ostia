import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { XzCompressor } from '@napi-rs/lzma'
import { tarOf } from '../test/fixtures/archives/archives'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

const PACKAGED = process.env.OSTIA_E2E_PACKAGED ?? ''
const BZIP2_FIXTURE = join(__dirname, '..', 'test', 'fixtures', 'archives', 'bz2-note.tar.bz2')

function archiveRoot(real: string): string {
  return `archive:${encodeURIComponent(real).replace(/!/g, '%21')}!`
}

test('the packaged app lists a tar.xz and a tar.bz2 through the archives extension and its vendored native decoder', async () => {
  test.skip(PACKAGED === '', 'runs only against a packaged build: OSTIA_E2E_PACKAGED=<executable>')
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const compressor = new XzCompressor({ preset: 0 })
  const tar = tarOf([{ name: 'xz-note.txt', data: 'packed in xz' }], false)
  writeFileSync(
    join(home, 'bundle.tar.xz'),
    Buffer.concat([compressor.update(tar), await compressor.finish()]),
  )
  copyFileSync(BZIP2_FIXTURE, join(home, 'bundle.tar.bz2'))
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    executablePath: PACKAGED,
    args: launch.args.filter((arg) => arg !== '.'),
    env: { ...launch.env, HOME: home },
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    for (const [name, entry] of [
      ['bundle.tar.xz', 'xz-note.txt'],
      ['bundle.tar.bz2', 'bz2-note.txt'],
    ]) {
      const root = archiveRoot(join(home, name))
      await expect
        .poll(
          () =>
            win.evaluate(
              async (path) =>
                (await window.ostia.fs.list(path)).map((item: { name: string }) => item.name),
              root,
            ),
          { timeout: 30_000 },
        )
        .toEqual([entry])
      const read = await win.evaluate(
        async (path) => window.ostia.fs.read(path),
        `${root}/${entry}`,
      )
      expect(read).toMatchObject({ ok: true })
    }
  } finally {
    await app.close()
  }
})
