import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../../..')
const SELF = 'extensions/screens'
const INSTALL_CODE = /^[a-z2-7]{26}$/

function marketplace(): { extensions: string[]; unlisted?: { path: string; code: string }[] } {
  const file = [
    join(root, 'marketplace/ostia-marketplace.json'),
    join(root, 'ostia-marketplace.json'),
  ].find((path) => existsSync(path))
  if (!file) throw new Error('no marketplace manifest')
  return JSON.parse(readFileSync(file, 'utf8'))
}

function json(file: string): Record<string, Record<string, string> | string> {
  return JSON.parse(readFileSync(join(__dirname, file), 'utf8'))
}

describe('screens ships as an Alpha that needs its install code', () => {
  it('SCX-C22 is not listed, only reachable with its own install code, says Alpha and shows the Alpha note', () => {
    const listing = marketplace()
    expect(listing.extensions).not.toContain(SELF)
    const unlisted = listing.unlisted ?? []
    const entry = unlisted.find((u) => u.path === SELF)
    expect(entry?.code).toMatch(INSTALL_CODE)
    expect(unlisted.filter((u) => u.code === entry?.code)).toHaveLength(1)

    const manifest = json('ostia.json') as { description: string; contributes: unknown }
    expect(manifest.description.startsWith('Alpha:')).toBe(true)
    expect(JSON.stringify(manifest)).not.toMatch(/"default":\s*true|startWithWindow/)
    const zh = json('locales/zh-Hant.json') as { manifest: { description: string } }
    expect(zh.manifest.description.startsWith('Alpha:')).toBe(true)

    for (const file of ['locales/en.json', 'locales/zh-Hant.json']) {
      const messages = (json(file) as { messages: Record<string, string> }).messages
      expect(messages['panel.alpha'], file).toMatch(/^Alpha\b/)
    }
  })
})
