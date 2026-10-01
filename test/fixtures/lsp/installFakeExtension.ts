import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const fixtures = join(__dirname, '..')

export const FAKE_LSP_BIN = join(fixtures, 'lsp', 'bin')

export function installFakeLanguageExtension(extensionsDir: string, id = 'fake-lang'): string {
  const dir = join(extensionsDir, id)
  mkdirSync(join(dir, 'server'), { recursive: true })
  copyFileSync(join(fixtures, 'extensions-lsp', id, 'pine.json'), join(dir, 'pine.json'))
  buildSync({
    entryPoints: [join(fixtures, 'lsp', 'fake-server.mjs')],
    outfile: join(dir, 'server', 'fake-server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
  return dir
}
