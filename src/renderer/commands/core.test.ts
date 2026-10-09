import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { en, mergeCatalog, zhHant } from '@shared/app/dict'
import { describe, expect, it } from 'vitest'
import { registerCore } from './core'
import { commandWording, commands } from './registry'

const ROOT = process.cwd()
const RENDERER = resolve(ROOT, 'src/renderer')

const sources = readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => {
    const path = join(RENDERER, f)
    return { file: relative(ROOT, path), text: readFileSync(path, 'utf8') }
  })

const REGISTER_CALL = /\bcommands\s*\.register\b/g

const CORE_FILE = 'src/renderer/commands/core.ts'

const WORDED_FILES = new Map([
  ['src/renderer/commands/assistToggles.ts', 'titles are built from the feature names'],
  ['src/renderer/lib/palette/userActions.ts', 'the title is the human’s own; the category is ours'],
  ['src/renderer/lib/extensions/views.ts', 'titles are built from the view’s own title'],
])

const TRANSLATED_ELSEWHERE = new Map([
  ['src/renderer/commands/extensionBridge.ts', 'main translates extension manifests'],
])

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

describe('core command wording', () => {
  it('registers every core command through registerCore, which takes its title from the dictionary', () => {
    const direct = sources
      .filter(({ file, text }) => file !== CORE_FILE && count(text, REGISTER_CALL) > 0)
      .filter(({ file }) => !WORDED_FILES.has(file) && !TRANSLATED_ELSEWHERE.has(file))
      .map(
        ({ file }) => `${file}: use registerCore and add the title to commands.titles in dict.ts`,
      )

    expect(direct).toEqual([])
  })

  it('words every other command registered by core through the dictionary', () => {
    const unworded = sources
      .filter(({ file }) => WORDED_FILES.has(file))
      .filter(({ text }) => count(text, /\.\.\.wordedBy\(/g) < count(text, REGISTER_CALL))
      .map(({ file }) => `${file}: spread wordedBy((d) => …) into the command`)

    expect(unworded).toEqual([])
  })

  it('keeps the allow-lists to files that still register commands', () => {
    const listed = [CORE_FILE, ...WORDED_FILES.keys(), ...TRANSLATED_ELSEWHERE.keys()]
    const stale = listed.filter(
      (file) => count(sources.find((s) => s.file === file)?.text ?? '', REGISTER_CALL) === 0,
    )

    expect(stale).toEqual([])
  })

  it('has a registration for every title in the dictionary', () => {
    const code = sources.map(({ text }) => text).join('\n')
    const shared = ['files/openFiles.ts', 'views/views.ts']
      .map((f) => readFileSync(resolve(ROOT, 'src/shared', f), 'utf8'))
      .join('\n')
    const unregistered = Object.keys(en.commands.titles).filter(
      (id) => !`${code}\n${shared}`.includes(`'${id}'`),
    )

    expect(unregistered).toEqual([])
  })

  it('translates every title, category and argument into Traditional Chinese', () => {
    const untranslated = (['titles', 'categories', 'arguments'] as const).flatMap((group) =>
      Object.entries(zhHant.commands[group])
        .filter(([, text]) => !/\p{Script=Han}/u.test(text))
        .map(([key]) => `${group}.${key}`),
    )

    expect(untranslated).toEqual([])
  })
})

describe('registerCore', () => {
  it('gives agents the English title and category whatever language the human reads', () => {
    registerCore({ id: 'pane.splitRight', category: 'pane', run: () => undefined })
    const described = commands.describe().find((c) => c.id === 'pane.splitRight')
    const registered = commands.list().find((c) => c.id === 'pane.splitRight')
    commands.unregister('pane.splitRight')

    expect(described).toMatchObject({ title: 'Split Pane Right', category: 'Pane' })
    expect(registered && commandWording(registered, mergeCatalog(zhHant))).toEqual({
      title: '向右分割窗格',
      category: '窗格',
    })
  })

  it('names the product in a title instead of leaving the placeholder', () => {
    registerCore({ id: 'app.quit', category: 'app', run: () => undefined })
    const registered = commands.list().find((c) => c.id === 'app.quit')
    commands.unregister('app.quit')

    expect(registered?.title).toBe('Quit Ostia')
    expect(registered && commandWording(registered, mergeCatalog(zhHant)).title).toBe('結束 Ostia')
  })

  it('asks for the argument in the human’s language', () => {
    registerCore({ id: 'workspace.mergeInto', category: 'workspace', run: () => undefined })
    const registered = commands.list().find((c) => c.id === 'workspace.mergeInto')
    commands.unregister('workspace.mergeInto')

    expect(registered?.argument).toBe('Workspace to merge into')
    expect(registered && commandWording(registered, mergeCatalog(zhHant)).argument).toBe(
      '要合併到的工作區',
    )
  })
})

describe('commandWording', () => {
  it('shows a command without wording as registered, so extension titles main translated stay', () => {
    commands.register({
      id: 'hello.open',
      title: '哈囉：開啟面板',
      category: '哈囉',
      run: () => {},
    })
    const registered = commands.list().find((c) => c.id === 'hello.open')
    commands.unregister('hello.open')

    expect(registered && commandWording(registered, mergeCatalog(zhHant))).toEqual({
      title: '哈囉：開啟面板',
      category: '哈囉',
      argument: undefined,
    })
  })
})
