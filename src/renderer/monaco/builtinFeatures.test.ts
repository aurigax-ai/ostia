import type { LanguageServerInfo } from '@shared/languageServers'
import { describe, expect, it } from 'vitest'
import { type BuiltinDefaults, BuiltinFeatures, claimedLanguages } from './builtinFeatures'

function server(extra: Partial<LanguageServerInfo>): LanguageServerInfo {
  return {
    key: 'ext/server',
    extId: 'ext',
    extName: 'Ext',
    serverId: 'server',
    name: 'Server',
    languages: ['typescript', 'javascript'],
    kind: 'bundled',
    command: 'server.js',
    enabled: true,
    status: 'idle',
    folders: 0,
    ...extra,
  }
}

class FakeDefaults implements BuiltinDefaults {
  changes = 0
  constructor(public modeConfiguration: Record<string, boolean | undefined>) {}
  setModeConfiguration(configuration: Record<string, boolean | undefined>): void {
    this.modeConfiguration = configuration
    this.changes += 1
  }
}

describe('claimedLanguages', () => {
  it('counts the languages of servers that are on and able to run', () => {
    expect(
      claimedLanguages([
        server({ status: 'running' }),
        server({ languages: ['python'], status: 'idle' }),
        server({ languages: ['json'], status: 'off', enabled: false }),
        server({ languages: ['css'], status: 'crashed' }),
        server({ languages: ['go'], status: 'program-missing' }),
        server({ languages: ['html'], status: 'pending-approval', enabled: false }),
        server({ languages: ['lua'], status: 'sandbox-unavailable' }),
      ]),
    ).toEqual(new Set(['typescript', 'javascript', 'python']))
  })
})

describe('BuiltinFeatures', () => {
  it('turns off every built-in feature of a claimed language except its tokenizer, once', () => {
    const typescript = new FakeDefaults({ completionItems: true, hovers: true, diagnostics: true })
    const json = new FakeDefaults({ tokens: true, hovers: true, diagnostics: true })
    const css = new FakeDefaults({ hovers: true })
    const features = new BuiltinFeatures(() => ({ typescript, json, css }))
    features.apply(new Set(['typescript', 'json', 'python']))
    features.apply(new Set(['typescript', 'json']))
    expect(typescript.modeConfiguration).toEqual({
      completionItems: false,
      hovers: false,
      diagnostics: false,
    })
    expect(json.modeConfiguration).toEqual({ tokens: true, hovers: false, diagnostics: false })
    expect(css.modeConfiguration).toEqual({ hovers: true })
    expect(typescript.changes).toBe(1)
    expect(css.changes).toBe(0)
  })

  it('gives a language its own features back, as they were, when no server claims it any more', () => {
    const original = { completionItems: true, hovers: false, diagnostics: true }
    const typescript = new FakeDefaults(original)
    const features = new BuiltinFeatures(() => ({ typescript }))
    features.apply(new Set(['typescript']))
    features.apply(new Set())
    features.apply(new Set())
    expect(typescript.modeConfiguration).toEqual(original)
    expect(typescript.changes).toBe(2)
  })

  it('ignores a language Monaco has no built-in features for', () => {
    const features = new BuiltinFeatures(() => ({ rust: undefined }))
    expect(() => features.apply(new Set(['rust']))).not.toThrow()
  })
})
