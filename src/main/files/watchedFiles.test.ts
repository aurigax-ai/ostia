import { describe, expect, it } from 'vitest'
import type { TreeChange } from './fileWatch'
import { parseFileWatchers, watchedFileEvents } from './watchedFiles'

const ROOT = '/home/u/work'

function events(registerOptions: unknown, changes: TreeChange[]): { uri: string; type: number }[] {
  return watchedFileEvents(parseFileWatchers(registerOptions, ROOT), changes, ROOT)
}

describe('watched files', () => {
  it('matches a relative glob against the path under the session root', () => {
    expect(
      events({ watchers: [{ globPattern: '**/*.{toml,cfg}' }] }, [
        { path: '/home/u/work/pkg/a.toml', kind: 'created' },
        { path: '/home/u/work/.hidden/b.cfg', kind: 'changed' },
        { path: '/home/u/work/pkg/c.txt', kind: 'changed' },
        { path: '/home/u/work/d.toml', kind: 'deleted' },
      ]),
    ).toEqual([
      { uri: 'file:///home/u/work/pkg/a.toml', type: 1 },
      { uri: 'file:///home/u/work/.hidden/b.cfg', type: 2 },
      { uri: 'file:///home/u/work/d.toml', type: 3 },
    ])
  })

  it('reports only the kinds a watcher asked for', () => {
    expect(
      events({ watchers: [{ globPattern: '**/*.txt', kind: 4 }] }, [
        { path: '/home/u/work/a.txt', kind: 'created' },
        { path: '/home/u/work/a.txt', kind: 'deleted' },
      ]),
    ).toEqual([{ uri: 'file:///home/u/work/a.txt', type: 3 }])
  })

  it('matches a relative pattern under its base folder, given as a URI or a workspace folder', () => {
    const changes: TreeChange[] = [
      { path: '/home/u/work/pkg/src/a.py', kind: 'changed' },
      { path: '/home/u/work/other/a.py', kind: 'changed' },
    ]
    for (const baseUri of [
      'file:///home/u/work/pkg',
      { uri: 'file:///home/u/work/pkg', name: 'p' },
    ]) {
      expect(
        events({ watchers: [{ globPattern: { baseUri, pattern: '**/*.py' } }] }, changes),
      ).toEqual([{ uri: 'file:///home/u/work/pkg/src/a.py', type: 2 }])
    }
  })

  it('drops a watcher based outside the session root and never reports a path outside it', () => {
    expect(
      parseFileWatchers(
        {
          watchers: [
            { globPattern: { baseUri: 'file:///home/u', pattern: '**' } },
            { globPattern: { baseUri: 'file:///home/u/workshop', pattern: '**' } },
            { globPattern: { baseUri: 'https://example.com/x', pattern: '**' } },
            { globPattern: 7 },
            'junk',
          ],
        },
        ROOT,
      ),
    ).toEqual([])
    expect(
      events({ watchers: [{ globPattern: '/home/u/**/*.txt' }] }, [
        { path: '/home/u/secret.txt', kind: 'changed' },
        { path: '/home/u/work/ok.txt', kind: 'changed' },
      ]),
    ).toEqual([{ uri: 'file:///home/u/work/ok.txt', type: 2 }])
  })
})
