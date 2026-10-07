import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tsnetHelperPath } from './tailnet'

const root = resolve(__dirname, '../../..')

describe('tsnetHelperPath', () => {
  it('TSN-C2 resolves the helper outside the asar and packages it unpacked', () => {
    expect(tsnetHelperPath('/opt/Ostia/resources/app.asar', 'linux')).toBe(
      '/opt/Ostia/resources/app.asar.unpacked/out/tsnet/ostia-tsnet',
    )
    expect(tsnetHelperPath('/home/dev/ostia', 'linux')).toBe(
      '/home/dev/ostia/out/tsnet/ostia-tsnet',
    )
    expect(tsnetHelperPath('C:\\Ostia\\resources\\app.asar', 'win32')).toMatch(
      /app\.asar\.unpacked.out.tsnet.ostia-tsnet\.exe$/,
    )
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/^asarUnpack:(\n\s+- .+)*\n\s+- out\/tsnet\/\*\*$/m)
  })
})
