import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'preserve',
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['src/**/*'],
  }),
  'src/shared/strings/appEn.ts': `export const appEn = {
  brand: { product: 'Acme Cloud' },
  greet: { bye: 'Goodbye', hello: 'Hello {name}', row: '{a} · {b}' },
  modes: { fast: 'Fast', slow: 'Slow' },
}
`,
  'src/shared/strings/appZhHant.ts': `import type { appEn } from './appEn'

export const appZhHant: typeof appEn = {
  brand: { product: 'Acme Cloud' },
  greet: { bye: '再見', hello: '你好 {name}', row: '{a} · {b}' },
  modes: { fast: '快', slow: '慢' },
}
`,
  'src/shared/app/dict.ts': `import { appEn } from '../strings/appEn'
import { appZhHant } from '../strings/appZhHant'

export const en = { greet: appEn.greet, modes: appEn.modes, brand: appEn.brand }
export type Dict = typeof en
export const zhHant: Dict = { greet: appZhHant.greet, modes: appZhHant.modes, brand: appZhHant.brand }
`,
  'src/main/use.ts': `import type { Dict } from '../shared/app/dict'

type Mode = keyof Dict['modes']

export function lines(d: Dict, mode: Mode): string[] {
  const greet = d.greet
  return [greet.hello, greet.bye, greet.row, d.modes[mode], d.brand.product]
}
`,
  'src/extensions/demo/ostia.json': JSON.stringify({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    api: '4.5',
    main: 'main.js',
    locales: ['zh-Hant'],
    contributes: { commands: [{ id: 'run', title: 'Run the demo' }] },
  }),
  'src/extensions/demo/locales/en.json': JSON.stringify({
    messages: { hi: 'Hi {name}', 'state.on': 'On', 'state.off': 'Off' },
  }),
  'src/extensions/demo/locales/zh-Hant.json': JSON.stringify({
    manifest: { name: '示範', 'commands.run.title': '執行示範' },
    messages: { hi: '嗨 {name}', 'state.on': '開', 'state.off': '關' },
  }),
  'src/extensions/demo/main.ts': `declare const t: (key: string, vars?: Record<string, string>) => string
export const hi = (name: string, on: boolean) => [t('hi', { name }), t(\`state.\${on ? 'on' : 'off'}\`)]
`,
  'i18n-allow.json': JSON.stringify({
    same: { 'zh-Hant': { 'product and brand names': ['brand.product'] } },
  }),
}

export interface I18nRepo {
  root: string
  write: (path: string, text: string) => void
  json: (path: string, value: unknown) => void
  remove: (path: string) => void
}

export function i18nRepo(): I18nRepo {
  const root = mkdtempSync(join(tmpdir(), 'i18n-repo-'))
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const [path, text] of Object.entries(FILES)) write(path, text)
  return {
    root,
    write,
    json: (path, value) => write(path, JSON.stringify(value)),
    remove: (path) => rmSync(join(root, path), { force: true }),
  }
}
