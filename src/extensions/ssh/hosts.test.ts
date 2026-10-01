import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILES, MAX_FILE_BYTES, MAX_HOSTS, discoverHosts } from './hosts'

let home: string

function write(path: string, text: string): void {
  const file = join(home, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pine-ssh-hosts-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('discoverHosts', () => {
  it('SSH-C4 lists plain aliases in file order, whatever the keyword spelling', () => {
    write(
      '.ssh/config',
      'Host web db\n  HostName 10.0.0.1\nhost=cache\n  User dev\nHOST = edge\n  Port 2200\n',
    )
    expect(discoverHosts(home)).toEqual({
      hosts: ['web', 'db', 'cache', 'edge'],
      truncated: false,
    })
  })

  it('SSH-C5 reads included files where the Include stands, in sorted order', () => {
    write(
      '.ssh/config',
      [
        'Host first',
        'Include config.d/*',
        'Host middle',
        '  Include ~/other',
        'Host last',
        '',
      ].join('\n'),
    )
    write('.ssh/config.d/b.conf', 'Host bravo\n')
    write('.ssh/config.d/a.conf', 'Host alpha\n')
    write('other', 'Host elsewhere\n')
    expect(discoverHosts(home).hosts).toEqual([
      'first',
      'alpha',
      'bravo',
      'middle',
      'elsewhere',
      'last',
    ])
  })

  it('SSH-C6 skips patterns, quoted names, option look-alikes, comments, Match lines and repeats', () => {
    write(
      '.ssh/config',
      [
        'Host *',
        'Host *.internal !bad "quoted" -oProxyCommand=x',
        'Host web # note',
        'Match host m',
        '  User matched',
        'Include missing.d/*',
        'Host web',
        '',
      ].join('\n'),
    )
    expect(discoverHosts(home)).toEqual({ hosts: ['web'], truncated: false })
  })

  it('SSH-C7 stays within its limits on missing, looping, deep, huge and long configs', () => {
    expect(discoverHosts(home)).toEqual({ hosts: [], truncated: false })

    write('.ssh/config', 'Host loop\nInclude config\n')
    expect(discoverHosts(home).hosts).toEqual(['loop'])

    write('.ssh/config', 'Host level0\nInclude level1\n')
    for (let level = 1; level <= 10; level++) {
      write(`.ssh/level${level}`, `Host level${level}\nInclude level${level + 1}\n`)
    }
    expect(discoverHosts(home).hosts).toEqual([
      'level0',
      'level1',
      'level2',
      'level3',
      'level4',
      'level5',
      'level6',
      'level7',
      'level8',
    ])

    write('.ssh/config', 'Host small\nInclude huge\n')
    write('.ssh/huge', `Host big\n${'#'.repeat(MAX_FILE_BYTES)}\n`)
    expect(discoverHosts(home).hosts).toEqual(['small'])

    write('.ssh/config', 'Include many.d/*\n')
    for (let i = 0; i < MAX_FILES + 6; i++) {
      write(`.ssh/many.d/f${String(i).padStart(2, '0')}`, `Host m${i}\n`)
    }
    expect(discoverHosts(home).hosts).toHaveLength(MAX_FILES - 1)

    const many = Array.from({ length: MAX_HOSTS + 5 }, (_, i) => `Host h${i}`).join('\n')
    write('.ssh/config', `${many}\n`)
    const found = discoverHosts(home)
    expect(found.hosts).toHaveLength(MAX_HOSTS)
    expect(found.hosts[MAX_HOSTS - 1]).toBe(`h${MAX_HOSTS - 1}`)
    expect(found.truncated).toBe(true)
  })
})
