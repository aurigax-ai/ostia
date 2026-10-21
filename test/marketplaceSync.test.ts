import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signExtension } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionSignature'
import { afterEach, describe, expect, it } from 'vitest'
import {
  historyFolders,
  placeAll,
  placement,
  signatureProblem,
  syncRelease,
  unseen,
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

const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function marketplace(current?: string): string {
  const root = tmp()
  write(
    join(root, 'ostia-marketplace.json'),
    JSON.stringify({ name: 'M', extensions: ['extensions/lsp-bash'] }),
  )
  if (current) {
    write(
      join(root, 'extensions/lsp-bash/ostia.json'),
      JSON.stringify({ id: 'lsp-bash', version: current }),
    )
    write(join(root, 'extensions/lsp-bash/main.js'), `// ${current}`)
    write(join(root, 'src/extensions/lsp-bash/main.ts'), `// ${current}`)
  }
  return root
}

interface Made {
  archive: string
  source: string
  expected: { id: string; version: string }
}

function release(
  version: string,
  opts: { id?: string; sign?: boolean; folder?: string; sourceVersion?: string } = {},
): Made {
  const id = opts.id ?? 'lsp-bash'
  const work = tmp()
  const folder = opts.folder ?? id
  write(join(work, folder, 'ostia.json'), JSON.stringify({ id, version }))
  write(join(work, folder, 'main.js'), `// ${version}`)
  if (opts.sign !== false) signExtension(join(work, folder), id, version, privatePem)
  const archive = join(work, 'release.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', work, folder])
  const source = join(work, 'source')
  write(join(source, 'ostia.json'), JSON.stringify({ id, version: opts.sourceVersion ?? version }))
  write(join(source, 'main.ts'), `// source ${version}`)
  return { archive, source, expected: { id: 'lsp-bash', version } }
}

const sync = (root: string, made: Made, key = publicKey) =>
  syncRelease(root, made.archive, made.source, made.expected, key)

describe('placement', () => {
  it('puts the newest stable release in extensions and every other, a pre-release always, in versions', () => {
    expect(placement(null, '1.0.0')).toBe('newest')
    expect(placement(null, '1.0.0-rc.1')).toBe('history')
    expect(placement('1.0.0', '1.0.1')).toBe('newest')
    expect(placement('1.0.1', '1.0.0')).toBe('history')
    expect(placement('1.0.0', '1.1.0-rc.1')).toBe('history')
    expect(placement('1.0.0', '2.0.0-rc.2')).toBe('history')
  })
})

describe('unseen', () => {
  it('keeps the valid tags this marketplace does not hold and drops the rest', () => {
    const root = marketplace('1.0.0')
    mkdirSync(join(root, 'versions/lsp-bash/0.9.0'), { recursive: true })
    expect(
      unseen(root, [
        'ext/lsp-bash/v1.0.0',
        'ext/lsp-bash/v0.9.0',
        'ext/lsp-bash/v1.0.1',
        "ext/lsp-bash/v1.0.1'; touch /tmp/x; '",
        'ext/lsp-bash/v$(id)',
        'ext/../x/v1.0.0',
        'v0.5.12',
        'sdk-v0.5.12',
      ]),
    ).toEqual([{ tag: 'ext/lsp-bash/v1.0.1', id: 'lsp-bash', version: '1.0.1' }])
  })
})

describe('syncRelease', () => {
  it('moves the previous newest into versions and takes the source of the new one', () => {
    const root = marketplace('1.0.0')
    expect(sync(root, release('1.0.1'))).toEqual({ id: 'lsp-bash', version: '1.0.1', newest: true })
    expect(readFileSync(join(root, 'extensions/lsp-bash/main.js'), 'utf8')).toBe('// 1.0.1')
    expect(readFileSync(join(root, 'versions/lsp-bash/1.0.0/main.js'), 'utf8')).toBe('// 1.0.0')
    expect(readFileSync(join(root, 'src/extensions/lsp-bash/main.ts'), 'utf8')).toBe(
      '// source 1.0.1',
    )
  })

  it('keeps an older or pre-release version in versions and leaves extensions alone', () => {
    const root = marketplace('1.1.0')
    for (const version of ['1.0.0', '1.2.0-rc.1']) {
      expect(sync(root, release(version))).toMatchObject({ version, newest: false })
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

  it('never makes a pre-release the newest, even for an id with no release yet', () => {
    const root = marketplace()
    expect(() => sync(root, release('1.0.0-rc.1'))).toThrow(/no stable release yet/)
    expect(existsSync(join(root, 'extensions/lsp-bash'))).toBe(false)
  })

  it('does nothing for a version it already holds', () => {
    const root = marketplace('1.0.0')
    expect(sync(root, release('1.0.0'))).toBeNull()
    expect(existsSync(join(root, 'versions'))).toBe(false)
  })

  it('refuses an unsigned, tampered or wrongly signed release', () => {
    const root = marketplace('1.0.0')
    expect(() => sync(root, release('1.0.1', { sign: false }))).toThrow(/ostia.sig is missing/)
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64')
    expect(() => sync(root, release('1.0.1'), other)).toThrow(/signature does not match/)
    expect(() => sync(root, release('1.0.1'), '')).toThrow(/holds no official key/)
    expect(readFileSync(join(root, 'extensions/lsp-bash/main.js'), 'utf8')).toBe('// 1.0.0')
  })

  it('refuses a tag that disagrees with the folder, the manifest or the source', () => {
    const root = marketplace('1.0.0')
    expect(() => sync(root, release('1.0.1', { folder: 'lsp-lua' }))).toThrow(
      /holds lsp-lua, not lsp-bash/,
    )
    const made = release('1.0.1')
    expect(() => sync(root, { ...made, expected: { id: 'lsp-bash', version: '1.0.2' } })).toThrow(
      /says lsp-bash 1.0.1, not lsp-bash 1.0.2/,
    )
    expect(() => sync(root, release('1.0.1', { sourceVersion: '0.0.1' }))).toThrow(/the source of/)
    expect(() => sync(root, release('1.0.1', { id: 'other' }))).toThrow()
  })

  it('refuses an extension the marketplace does not list', () => {
    const root = marketplace()
    const made = release('1.0.0', { id: 'newcomer' })
    expect(() => sync(root, { ...made, expected: { id: 'newcomer', version: '1.0.0' } })).toThrow(
      /not in ostia-marketplace.json/,
    )
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

describe('signatureProblem', () => {
  it('reads what the SDK signs and refuses a link in the folder', () => {
    const dir = tmp()
    write(join(dir, 'ostia.json'), '{}')
    write(join(dir, 'locales/fr.json'), '{}')
    signExtension(dir, 'csv', '1.0.0', privatePem)
    expect(signatureProblem(dir, 'csv', '1.0.0', publicKey)).toBeNull()
    expect(signatureProblem(dir, 'csv', '1.0.1', publicKey)).toBe('the signature does not match')
    symlinkSync('/etc/passwd', join(dir, 'link'))
    expect(() => signatureProblem(dir, 'csv', '1.0.0', publicKey)).toThrow(/not a plain file/)
  })

  it('wants an Ed25519 key', () => {
    const dir = tmp()
    write(join(dir, 'ostia.json'), '{}')
    signExtension(dir, 'csv', '1.0.0', privatePem)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64')
    expect(signatureProblem(dir, 'csv', '1.0.0', rsa)).toContain('does not hold an Ed25519 key')
  })
})

describe('placeAll', () => {
  it('places the good releases and reports each bad one instead of stopping at it', () => {
    const root = marketplace('1.0.0')
    const assets = tmp()
    const sources = tmp()
    const put = (made: Made, base: string): void => {
      execFileSync('cp', [made.archive, join(assets, `${base}.tar.gz`)])
      execFileSync('cp', ['-r', made.source, join(sources, base)])
    }
    put(release('1.0.1', { sign: false }), 'lsp-bash-1.0.1')
    put(release('1.0.2'), 'lsp-bash-1.0.2')
    put(release('1.0.3', { folder: 'lsp-lua' }), 'lsp-bash-1.0.3')
    writeFileSync(join(assets, 'nonsense.tar.gz'), 'x')
    const { placed, failures } = placeAll(root, assets, sources, publicKey)
    expect(placed).toEqual(['lsp-bash 1.0.2 -> extensions'])
    expect(failures).toHaveLength(3)
    expect(failures.join('\n')).toMatch(/lsp-bash-1.0.1: .*ostia.sig is missing/)
    expect(failures.join('\n')).toMatch(/lsp-bash-1.0.3: .*holds lsp-lua/)
    expect(readFileSync(join(root, 'extensions/lsp-bash/main.js'), 'utf8')).toBe('// 1.0.2')
  })
})
