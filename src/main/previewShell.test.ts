import { describe, expect, it } from 'vitest'
import { runtimeImportMap } from '../shared/artifactRuntime'
import { binaryPackage, unpackedPath } from './esbuildService'
import { ENTRY_MODULE_PATH, shellModule, shellPage } from './previewShell'

describe('shellPage', () => {
  const page = shellPage('N0nce', { dark: true, vars: { '--ostia-bg': '#101214' } })

  it('carries the import map generated from the runtime list, and Tailwind', () => {
    const map = /<script type="importmap" nonce="N0nce">(.*?)<\/script>/.exec(page)?.[1]
    expect(JSON.parse(map ?? '{}')).toEqual(runtimeImportMap())
    expect(page).toContain('<script nonce="N0nce" src="/runtime/tailwind.js"></script>')
  })

  it('puts the nonce on every script and names no remote origin', () => {
    expect(page.match(/<script/g)).toHaveLength(3)
    expect(page.match(/<script[^>]*nonce="N0nce"/g)).toHaveLength(3)
    expect(page).not.toMatch(/https?:/)
  })

  it('follows the app theme', () => {
    expect(page).toContain('<html class="dark">')
    expect(page).toContain('color-scheme:dark;--ostia-bg:#101214')
    expect(shellPage('n', { dark: false, vars: {} })).toContain('<html>')
  })
})

describe('shellModule', () => {
  it('mounts the entry’s default export inside an error boundary that logs', () => {
    const code = shellModule()
    expect(code).toContain(`import(${JSON.stringify(ENTRY_MODULE_PATH)})`)
    expect(code).toContain("from 'react-dom/client'")
    expect(code).toContain('componentDidCatch')
    expect(code).toContain('console.error')
    expect(code).not.toMatch(/window\.ostia|fetch\(|eval\(|new Function/)
  })
})

describe('the packaged compiler', () => {
  it('runs the binary from outside the archive', () => {
    expect(
      unpackedPath('/opt/ostia/resources/app.asar/node_modules/@esbuild/linux-x64/bin/esbuild'),
    ).toBe('/opt/ostia/resources/app.asar.unpacked/node_modules/@esbuild/linux-x64/bin/esbuild')
    expect(unpackedPath('/x/app.asar.unpacked/node_modules/esbuild')).toBe(
      '/x/app.asar.unpacked/node_modules/esbuild',
    )
    expect(binaryPackage('linux', 'x64')).toBe('@esbuild/linux-x64/bin/esbuild')
    expect(binaryPackage('darwin', 'arm64')).toBe('@esbuild/darwin-arm64/bin/esbuild')
  })
})
