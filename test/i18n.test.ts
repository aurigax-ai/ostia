import { describe, expect, it } from 'vitest'
import { runChecks } from '../scripts/i18nCheck.mjs'
import {
  COMMENT_MARKER,
  baselineOf,
  coverageMarkdown,
  coverageRows,
  percent,
} from '../scripts/i18nCoverage.mjs'
import { sortCatalogues } from '../scripts/i18nOrder.mjs'
import { type I18nRepo, i18nRepo } from './i18nFixture'

async function problemsOf(change: (repo: I18nRepo) => void): Promise<string[]> {
  const repo = i18nRepo()
  change(repo)
  sortCatalogues(repo.root)
  return (await runChecks(repo.root)).problems
}

function zhGreet(repo: I18nRepo, greet: string): void {
  repo.write(
    'src/shared/strings/appZhHant.ts',
    `import type { appEn } from './appEn'

export const appZhHant: typeof appEn = {
  greet: ${greet},
  modes: { fast: '快', slow: '慢' },
  brand: { product: 'Acme Cloud' },
}
`,
  )
}

function catalogue(repo: I18nRepo, en: string, zh: string): void {
  repo.write(
    'src/shared/strings/appEn.ts',
    `export const appEn = {\n  greet: { hello: 'Hello {name}', bye: 'Goodbye', row: '{a} · {b}' },\n  modes: ${en},\n  brand: { product: 'Acme Cloud' },\n}\n`,
  )
  repo.write(
    'src/shared/strings/appZhHant.ts',
    `import type { appEn } from './appEn'\nexport const appZhHant: typeof appEn = {\n  greet: { hello: '你好 {name}', bye: '再見', row: '{a} · {b}' },\n  modes: ${zh},\n  brand: { product: 'Acme Cloud' },\n}\n`,
  )
}

const DEMO_ZH = { name: '示範', 'commands.run.title': '執行示範' }

describe('i18n check', () => {
  it('finds nothing in a repository without drift', async () => {
    expect(await problemsOf(() => {})).toEqual([])
  })

  it('names a catalogue whose keys are not sorted', async () => {
    const repo = i18nRepo()
    repo.write(
      'src/shared/strings/appEn.ts',
      "export const appEn = {\n  modes: { fast: 'Fast', slow: 'Slow' },\n  greet: { bye: 'Goodbye' },\n}\n",
    )
    const problems = (await runChecks(repo.root)).problems
    expect(problems).toContain(
      'unsorted: src/shared/strings/appEn.ts: keys must be sorted. Run node scripts/i18n.mjs sort.',
    )
  })

  it('I18N-C1 names a key a catalogue has no translation for', async () => {
    expect(
      await problemsOf((repo) =>
        repo.json('src/extensions/demo/locales/zh-Hant.json', {
          manifest: DEMO_ZH,
          messages: { 'state.on': '開', 'state.off': '關' },
        }),
      ),
    ).toEqual([
      'missing: demo zh-Hant messages.hi: no translation. Add it to src/extensions/demo/locales/zh-Hant.json.',
    ])
  })

  it('I18N-C2 fails a value copied from English, but not an allowed name or text with nothing to translate', async () => {
    expect(
      await problemsOf((repo) =>
        zhGreet(repo, "{ hello: '你好 {name}', bye: 'Goodbye', row: '{a} · {b}' }"),
      ),
    ).toEqual([
      'copied: zh-Hant greet.bye = "Goodbye": translate it in src/shared/strings/appZhHant.ts, or list it under same.zh-Hant in i18n-allow.json if it is a product or protocol name.',
    ])
  })

  it('I18N-C3 fails a placeholder renamed in a translation', async () => {
    expect(
      await problemsOf((repo) =>
        zhGreet(repo, "{ hello: '你好 {who}', bye: '再見', row: '{a} · {b}' }"),
      ),
    ).toEqual([
      'placeholder: zh-Hant greet.hello: en has {name}, the translation has {who}. Use the same placeholders in src/shared/strings/appZhHant.ts.',
    ])
  })

  it('I18N-C4 fails a key no source reads, also one only a test reads', async () => {
    const problems = await problemsOf((repo) => {
      repo.write(
        'src/shared/strings/appEn.ts',
        `export const appEn = {\n  greet: { hello: 'Hello {name}', bye: 'Goodbye', row: '{a} · {b}', extra: 'Extra', tested: 'Tested' },\n  modes: { fast: 'Fast', slow: 'Slow' },\n  brand: { product: 'Acme Cloud' },\n}\n`,
      )
      zhGreet(
        repo,
        "{ hello: '你好 {name}', bye: '再見', row: '{a} · {b}', extra: '額外', tested: '測試' }",
      )
      repo.write(
        'src/main/use.test.ts',
        "import { en } from '../shared/app/dict'\nexport const x = en.greet.tested\n",
      )
    })
    expect(problems).toEqual([
      'unused: greet.extra: no source outside tests reads it. Remove it from src/shared/strings/appEn.ts and every translation.',
      'unused: greet.tested: no source outside tests reads it. Remove it from src/shared/strings/appEn.ts and every translation.',
    ])
  })

  it('I18N-C4 counts every key of an object read through Object.values, an alias or a key union', async () => {
    const problems = await problemsOf((repo) => {
      catalogue(
        repo,
        "{ fast: 'Fast', slow: 'Slow', mid: 'Mid' }",
        "{ fast: '快', slow: '慢', mid: '中' }",
      )
      repo.write(
        'src/main/use.ts',
        `import type { Dict } from '../shared/app/dict'\nexport function lines(d: Dict): string[] {\n  const greet = d.greet\n  return [greet.hello, greet.bye, greet.row, ...Object.values(d.modes), d.brand.product]\n}\n`,
      )
    })
    expect(problems).toEqual([])
  })

  it('I18N-C5 fails hardcoded JSX text and text attributes, never machine text or tests', async () => {
    const problems = await problemsOf((repo) => {
      repo.write(
        'src/renderer/View.tsx',
        `declare const cn: (...c: string[]) => string
export const View = () => (
  <div>
    <p>Click here</p>
    <span className="font-mono">some/path id</span>
    <code>npm run</code>
    <b className={cn('text-sm', 'font-mono')}>a value</b>
    <button title="Open it" />
    <input placeholder="https://x.dev" />
    <input placeholder="Type a name" />
    <i>{'Quoted text'}</i>
  </div>
)
`,
      )
      repo.write('src/renderer/View.test.tsx', 'export const T = () => <p>Test only text</p>\n')
    })
    const end =
      'is user-visible text. Put it in src/shared/strings/ (en and zh-Hant) and read it through the dictionary.'
    expect(problems).toEqual([
      `literal: src/renderer/View.tsx:4: JSX text "Click here" ${end}`,
      `literal: src/renderer/View.tsx:8: title attribute "Open it" ${end}`,
      `literal: src/renderer/View.tsx:10: placeholder attribute "Type a name" ${end}`,
      `literal: src/renderer/View.tsx:11: JSX text "Quoted text" ${end}`,
    ])
  })

  it('I18N-C6 fails main dialog, menu and page text, never control replies or the old-folders prompt', async () => {
    const problems = await problemsOf((repo) => {
      repo.write(
        'src/main/dialogs.ts',
        `declare const dialog: { showMessageBox: (o: unknown) => void }
export function ask(): void {
  dialog.showMessageBox({ message: 'Quit now?', buttons: ['Quit', 'Cancel'] })
}
export const menu = [{ label: 'Reload', role: 'reload' }]
export const reply = { ok: false, message: 'no pane has that id' }
export const page = (name: string) => \`<!doctype html><title>\${name}</title><p>Sign in again</p>\`
`,
      )
      repo.write(
        'src/main/platform/oldDirsPrompt.ts',
        "export const old = { title: 'Move your data' }\n",
      )
    })
    const end =
      'is user-visible text. Put it in src/shared/strings/ (en and zh-Hant) and read it through the dictionary.'
    expect(problems).toEqual([
      `literal: src/main/dialogs.ts:3: buttons: "Cancel" ${end}`,
      `literal: src/main/dialogs.ts:3: buttons: "Quit" ${end}`,
      `literal: src/main/dialogs.ts:3: message: "Quit now?" ${end}`,
      `literal: src/main/dialogs.ts:5: label: "Reload" ${end}`,
      `literal: src/main/dialogs.ts:7: HTML text "Sign in again" ${end}`,
    ])
  })

  it('I18N-C7 fails a language pack that adds a key or claims English', async () => {
    const problems = await problemsOf((repo) => {
      repo.json('src/extensions/pack/ostia.json', {
        id: 'pack',
        name: 'Pack',
        version: '1.0.0',
        api: '7.0',
        category: 'langpack',
        contributes: {
          languages: [
            { id: 'fr', label: 'Français', path: 'fr.json' },
            { id: 'en', label: 'English', path: 'en.json' },
          ],
        },
      })
      repo.json('src/extensions/pack/fr.json', {
        greet: { hello: 'Bonjour {name}', bye: 'Au revoir', row: '{a} · {b}', added: 'Ajouté' },
        modes: { fast: 'Rapide', slow: 'Lent' },
        brand: { product: 'Acme Cloud' },
      })
      repo.json('src/extensions/pack/en.json', {})
      repo.json('i18n-allow.json', {
        same: {
          'zh-Hant': { 'product and brand names': ['brand.product'] },
          'pack:fr': { 'product and brand names': ['brand.product'] },
        },
      })
    })
    expect(problems).toEqual([
      "pack adds a key: pack fr greet.added (src/extensions/pack/fr.json): packs translate the catalogue's keys only. Remove it.",
      "pack replaces English: pack language 'en' (src/extensions/pack/ostia.json). English is the catalogue; a pack adds another language.",
    ])
  })

  it('I18N-C8 checks an extension catalogue against its English messages and its code', async () => {
    const problems = await problemsOf((repo) => {
      repo.json('src/extensions/demo/locales/en.json', {
        messages: { hi: 'Hi {name}', 'state.on': 'On', 'state.off': 'Off', gone: 'Gone' },
      })
      repo.json('src/extensions/demo/locales/zh-Hant.json', {
        manifest: DEMO_ZH,
        messages: {
          hi: '嗨 {name}',
          'state.on': '開',
          'state.off': '關',
          gone: '走了',
          stray: '多餘',
        },
      })
      repo.write(
        'src/extensions/demo/main.ts',
        "declare const t: (key: string, vars?: Record<string, string>) => string\nexport const hi = (name: string, on: boolean) => [t('hi', { name }), t(`state.${on ? 'on' : 'off'}`), t('nope')]\n",
      )
    })
    expect(problems).toEqual([
      'extra: demo zh-Hant messages.stray: not in en. Remove it from src/extensions/demo/locales/zh-Hant.json.',
      "undefined: demo t('nope') at src/extensions/demo/main.ts:2: no English message. Add it to src/extensions/demo/locales/en.json.",
      'unused: demo message gone: no code reads it. Remove it from src/extensions/demo/locales/*.json.',
    ])
  })

  it('I18N-C8 fails messages with no English catalogue', async () => {
    const problems = await problemsOf((repo) => repo.remove('src/extensions/demo/locales/en.json'))
    expect(problems).toContain(
      'extension: demo has messages but no src/extensions/demo/locales/en.json. Put the English messages there and read them with t().',
    )
  })

  it('I18N-C9 fails an allow-list entry that matches nothing', async () => {
    const problems = await problemsOf((repo) =>
      repo.json('i18n-allow.json', {
        same: { 'zh-Hant': { 'product and brand names': ['brand.product', 'brand.gone'] } },
        literals: { text: { 'example inputs': ['nothing here'] } },
      }),
    )
    expect(problems).toEqual([
      'stale: i18n-allow.json literals.text "example inputs": "nothing here" matches nothing. Remove it.',
      'stale: i18n-allow.json same.zh-Hant "product and brand names": "brand.gone" matches nothing. Remove it.',
    ])
  })
})

describe('i18n coverage', () => {
  const rows = (status: string, n: number, reason?: string) =>
    Array.from({ length: n }, (_, i) => ({ key: `${status}.${i}`, status, reason }))

  it('I18N-C10 counts translated over total per language, area, pack and extension, and rounds down', () => {
    const coverage = coverageRows({
      core: [
        {
          language: 'zh-Hant',
          rows: [...rows('translated', 2999), ...rows('copied', 1), ...rows('skip', 5)],
        },
      ],
      areaOf: (key: string) => (key.startsWith('copied') ? 'app' : 'settings'),
      packs: [{ id: 'langpack-zh-hant', language: 'zh-Hant', rows: rows('translated', 3) }],
      extensions: [
        {
          id: 'demo',
          results: [
            { language: 'zh-Hant', rows: [...rows('same', 1, 'names'), ...rows('missing', 1)] },
          ],
        },
      ],
    })
    expect(coverage.map((row) => [row.label, row.counts])).toEqual([
      ['Core', [2999, 3000]],
      ['Core · app', [0, 1]],
      ['Core · settings', [2999, 2999]],
      ['Pack langpack-zh-hant', [3, 3]],
      ['Extension demo', [1, 2]],
    ])
    expect(percent([2999, 3000])).toBe(99.9)
    expect(percent([0, 0])).toBe(100)
  })

  it('I18N-C10 renders the sticky-comment marker, a table and the change against main', () => {
    const now = [
      {
        id: 'core:zh-Hant',
        label: 'Core',
        language: 'zh-Hant',
        counts: [9, 10] as [number, number],
      },
    ]
    const before = baselineOf([{ ...now[0], counts: [10, 10] }], 'abcdef1234')
    const text = coverageMarkdown(now, { baseline: before, same: new Map([['names', 2]]) })
    expect(text.split('\n').slice(0, 6)).toEqual([
      COMMENT_MARKER,
      '### Translation coverage',
      '',
      '| Catalogue | zh-Hant |',
      '|---|---|',
      '| Core | 90.0% (9 of 10); main 100.0% (-10.0) |',
    ])
    expect(text).toContain('Compared with main at abcdef1.')
    expect(text).toContain('Identical to English by design: 2 (names 2).')
    expect(coverageMarkdown(now)).toContain('No translation coverage of main to compare with yet.')
  })
})
