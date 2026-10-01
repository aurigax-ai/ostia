import {
  ASSIST_PROVIDERS_MAX,
  ASSIST_PROVIDER_MODELS_MAX,
  type AssistProviderConfig,
} from '@shared/assist'
import { describe, expect, it } from 'vitest'
import { newProviderId, patchProvider, withModel, withProvider } from './assistProviders'

const KIND = { id: 'openai-compatible', title: 'OpenAI-compatible', baseUrl: '', key: 'optional' }

const first: AssistProviderConfig = {
  id: 'openai-compatible',
  extId: 'assistant',
  kind: 'openai-compatible',
  name: 'OpenAI-compatible',
  baseUrl: 'http://a/v1',
  enabled: true,
  models: ['m'],
}

describe('newProviderId', () => {
  it('uses the kind, then numbers the next ones', () => {
    expect(newProviderId('ollama', [])).toBe('ollama')
    expect(newProviderId('ollama', ['ollama'])).toBe('ollama-2')
    expect(newProviderId('ollama', ['ollama', 'ollama-2'])).toBe('ollama-3')
  })
})

describe('withProvider', () => {
  it('adds a second provider of the same kind with its own id and a name that tells them apart', () => {
    const next = withProvider([first], 'assistant', KIND as never)
    expect(next).toEqual([
      first,
      {
        id: 'openai-compatible-2',
        extId: 'assistant',
        kind: 'openai-compatible',
        name: 'OpenAI-compatible (openai-compatible-2)',
        baseUrl: '',
        enabled: true,
        models: [],
      },
    ])
  })

  it('refuses one more than the cap', () => {
    const full = Array.from({ length: ASSIST_PROVIDERS_MAX }, (_, n) => ({ ...first, id: `p${n}` }))
    expect(withProvider(full, 'assistant', KIND as never)).toBeNull()
  })
})

describe('patchProvider', () => {
  it('changes only the named provider', () => {
    const other = { ...first, id: 'other' }
    expect(patchProvider([first, other], 'other', { enabled: false })).toEqual([
      first,
      { ...other, enabled: false },
    ])
  })
})

describe('withModel', () => {
  it('adds a trimmed id once and refuses blanks, duplicates and one past the cap', () => {
    expect(withModel(['a'], '  b/c:d  ')).toEqual(['a', 'b/c:d'])
    expect(withModel(['a'], 'a')).toBeNull()
    expect(withModel(['a'], '   ')).toBeNull()
    const full = Array.from({ length: ASSIST_PROVIDER_MODELS_MAX }, (_, n) => `m${n}`)
    expect(withModel(full, 'one-more')).toBeNull()
  })
})
