import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  historyFolders,
  placement,
  syncRelease,
  writeHistory,
} from '../marketplace/sync-releases.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-releases-'))
  dirs.push(dir)
  return dir
}

function write(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

function marketplace(current?: string): string {
  const root = tmp()
  write(
    join(root, 'ostia-marketplace.json'),
    JSON.stringify({ name: 'M', extensions: ['extensions/lsp-bash'] }),
  )
  if (current) {
    write(join(root, 'extensions/lsp-bash/ostia.json'), JSON.stringify({ version: current }))
    write(join(root, 'extensions/lsp-bash/main.js'), `// ${current}`)
    write(join(root, 'src/extensions/lsp-bash/main.ts'), `// ${current}`)
  }
  return root
}

function release(id: string, version: string): { archive: string; source: string } {
  const work = tmp()
  write(join(work, id, 'ostia.json'), JSON.stringify({ id, version }))
  write(join(work, id, 'main.js'), `// ${version}`)
  const archive = join(work, `${id}-${version}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', work, id])
  const source = join(work, 'source')
  write(join(source, 'main.ts'), `// source ${version}`)
  return { archive, source }
}

describe('placement', () => {
  it('puts the newest stable release in extensions and every other in versions', () => {
    expect(placement(null, '1.0.0')).toBe('newest')
    expect(placement(null, '1.0.0-rc.1')).toBe('newest')
    expect(placement('1.0.0', '1.0.1')).toBe('newest')
    expect(placement('1.0.1', '1.0.0')).toBe('history')
    expect(placement('1.0.0', '1.1.0-rc.1')).toBe('history')
    expect(placement('1.0.0-rc.1', '0.9.0')).toBe('newest')
    expect(placement('1.0.0-rc.1', '1.0.0-rc.2')).toBe('newest')
  })
})

describe('syncRelease', () => {
  it('moves the previous newest into versions and takes the source of the new one', () => {
    const root = marketplace('1.0.0')
    const { archive, source } = release('lsp-bash', '1.0.1')
    expect(syncRelease(root, archive, source)).toEqual({
      id: 'lsp-bash',
      version: '1.0.1',
      newest: true,
    })
    expect(readFileSync(join(root, 'extensions/lsp-bash/main.js'), 'utf8')).toBe('// 1.0.1')
    expect(readFileSync(join(root, 'versions/lsp-bash/1.0.0/main.js'), 'utf8')).toBe('// 1.0.0')
    expect(readFileSync(join(root, 'src/extensions/lsp-bash/main.ts'), 'utf8')).toBe(
      '// source 1.0.1',
    )
  })

  it('keeps an older or pre-release version in versions and leaves extensions alone', () => {
    const root = marketplace('1.1.0')
    for (const version of ['1.0.0', '1.2.0-rc.1']) {
      const { archive, source } = release('lsp-bash', version)
      expect(syncRelease(root, archive, source)).toMatchObject({ version, newest: false })
    }
    expect(readFileSync(join(root, 'extensions/lsp-bash/main.js'), 'utf8')).toBe('// 1.1.0')
    expect(historyFolders(root)).toEqual([
      'versions/lsp-bash/1.0.0',
      'versions/lsp-bash/1.2.0-rc.1',
    ])
    writeHistory(root)
    expect(JSON.parse(readFileSync(join(root, 'ostia-marketplace.json'), 'utf8')).history).toEqual([
      'versions/lsp-bash/1.0.0',
      'versions/lsp-bash/1.2.0-rc.1',
    ])
  })

  it('does nothing for a version it already holds', () => {
    const root = marketplace('1.0.0')
    const { archive, source } = release('lsp-bash', '1.0.0')
    expect(syncRelease(root, archive, source)).toBeNull()
    expect(existsSync(join(root, 'versions'))).toBe(false)
  })

  it('refuses an extension the marketplace does not list', () => {
    const root = marketplace()
    const { archive, source } = release('newcomer', '1.0.0')
    expect(() => syncRelease(root, archive, source)).toThrow(/not in ostia-marketplace.json/)
  })

  it('drops the history field when there is none', () => {
    const root = marketplace('1.0.0')
    writeHistory(root)
    expect(JSON.parse(readFileSync(join(root, 'ostia-marketplace.json'), 'utf8'))).toEqual({
      name: 'M',
      extensions: ['extensions/lsp-bash'],
    })
  })
})
