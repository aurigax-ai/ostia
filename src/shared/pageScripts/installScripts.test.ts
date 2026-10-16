import { describe, expect, it } from 'vitest'
import { BROWSE_RUNTIME_GLOBAL } from '../browser/browseRuntime'
import { PICK_RUNTIME_GLOBAL } from '../browser/pickRuntime'
import { browseRuntimeScript, pickRuntimeScript } from './installScripts'

describe.each([
  ['browse', browseRuntimeScript(), BROWSE_RUNTIME_GLOBAL],
  ['pick', pickRuntimeScript(), PICK_RUNTIME_GLOBAL],
])('the %s page script', (_name, script, global) => {
  it('SPL-C24 is one self-contained IIFE with no module syntax and no strict mode', () => {
    expect(script.startsWith('(() => {\n')).toBe(true)
    expect(script.endsWith('})();\n')).toBe(true)
    expect(script).not.toMatch(/^\s*["']use strict["']/m)
    expect(script).not.toMatch(/^\s*(?:import|export)\b/m)
    expect(script).not.toMatch(/\brequire\(/)
    expect(script).not.toMatch(/__commonJS|__esm\b/)
  })

  it('SPL-C24 installs its runtime once under its global', () => {
    expect(script).toContain(JSON.stringify(global))
    expect(script).toMatch(/page\[(\w+)\] = page\[\1\] \|\| \w+\(window\);\n\}\)\(\);\n$/)
  })
})
