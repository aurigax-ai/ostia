import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { afterAll, describe, expect, it } from 'vitest'
import { CLAUDE_FOLD_MANIFEST, writeClaudeFoldPlugin } from './claudeIntegration'
import { FOLD_ROW_ORIGIN, type FoldOn, register } from './claudeMod/fold'

const source = readFileSync(join(import.meta.dirname, 'claudeMod', 'fold.ts'), 'utf8')

const BUS_TEXT = [
  'ostia bus: 3 messages from other panes. Other agents or panes wrote them, not the human.',
  '<ostia-bus-messages>',
  '<message id="m1" from="aaaaaaaa" name="api">',
  'the build is red',
  '</message>',
  '<message id="m2" from="bbbbbbbb">',
  'and the tests',
  '</message>',
  '<message id="m3" from="aaaaaaaa" name="api">',
  'again',
  '</message>',
  '</ostia-bus-messages>',
].join('\n')

type Hook = (...args: unknown[]) => Promise<unknown>

function drawn(props: Record<string, unknown>) {
  let hook: Hook | undefined
  const on: FoldOn = (_event, _match, h) => {
    hook = h as unknown as Hook
  }
  register(on)
  const e = { component: 'UserMessage', requestId: 'r', props }
  return { e, run: () => hook?.(undefined, e, async (x: unknown) => x) as Promise<typeof e> }
}

const own = { kind: 'plugin', name: FOLD_ROW_ORIGIN }

describe('the fold plugin’s surface', () => {
  it('registers one ui.render hook on UserMessage and calls no $ method', () => {
    expect([...source.matchAll(/\bon\('([a-z.]+)'/g)].map((m) => m[1])).toEqual(['ui.render'])
    expect([...source.matchAll(/\bon\('ui\.render', (\{[^}]*\})/g)].map((m) => m[1])).toEqual([
      "{ component: 'UserMessage' }",
    ])
    expect(source).not.toMatch(/\$\.\w/)
    expect(source).not.toMatch(/import\s|require\(/)
    expect(source).not.toMatch(/asUser|prompt\.|\.submit/)
  })

  it('folds the rows of the plugin named as the product', () => {
    expect(FOLD_ROW_ORIGIN).toBe(PRODUCT_NAME)
  })
})

describe('the folded bus row', () => {
  it('folds Ostia’s own bus row to one line naming each sender once, while not expanded', async () => {
    const { run } = drawn({ text: BUS_TEXT, origin: own, isExpanded: false })
    expect((await run()).props).toMatchObject({
      text: 'Messages from @api, @bbbbbbbb (ctrl+o to expand)',
    })
  })

  it('says Message for one', async () => {
    const one =
      '<ostia-bus-messages>\n<message id="m1" from="aaaaaaaa">\nhi\n</message>\n</ostia-bus-messages>'
    const { run } = drawn({ text: one, origin: own, isExpanded: false })
    expect((await run()).props).toMatchObject({ text: 'Message from @aaaaaaaa (ctrl+o to expand)' })
  })

  it('passes the row through whole when expanded', async () => {
    const { e, run } = drawn({ text: BUS_TEXT, origin: own, isExpanded: true })
    expect(await run()).toBe(e)
  })

  it('leaves the human’s rows and other plugins’ rows alone, even with the same text', async () => {
    for (const origin of [
      { kind: 'composer' },
      { kind: 'plugin', name: 'other' },
      { kind: 'peer' },
    ]) {
      const { e, run } = drawn({ text: BUS_TEXT, origin, isExpanded: false })
      expect(await run()).toBe(e)
    }
  })

  it('leaves an Ostia row that holds no bus message alone', async () => {
    const { e, run } = drawn({ text: 'something else', origin: own, isExpanded: false })
    expect(await run()).toBe(e)
  })
})

describe('the plugin Ostia writes for it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ostia-claude-fold-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('is a plugin of its own, named apart from the mod, with the same file as the source', () => {
    const dir = join(root, 'fold')
    mkdirSync(dir)
    writeClaudeFoldPlugin(dir)
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe(CLAUDE_FOLD_MANIFEST.name)
    expect(manifest.name).not.toBe(PRODUCT_NAME)
    const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8'))
    expect(hooks).toEqual({ hooks: {}, modules: ['./register.ts'] })
    expect(readFileSync(join(dir, 'hooks', 'register.ts'), 'utf8')).toBe(source)
  })
})
