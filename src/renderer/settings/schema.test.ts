import { beforeEach, describe, expect, it, vi } from 'vitest'
import { monaco } from '../monaco/setup'
import { SETTINGS_JSON_SCHEMA, registerSettingsSchema } from './schema'

// Monaco's real setup pulls in Vite `?worker` imports that do not resolve under Vitest,
// so stub the surface `registerSettingsSchema` actually touches.
vi.mock('../monaco/setup', () => ({
  monaco: {
    Uri: { file: (p: string) => ({ toString: () => `file://${p}` }) },
    languages: { json: { jsonDefaults: { setDiagnosticsOptions: vi.fn() } } },
  },
}))

// `languages.json` is typed as a deprecated stub in the ESM build (see schema.ts); the mock
// factory above populates `jsonDefaults` at runtime, so cast to reach it — mirrors the source.
const setDiagnosticsOptions = vi.mocked(
  (
    monaco.languages.json as unknown as {
      jsonDefaults: { setDiagnosticsOptions: (options: unknown) => void }
    }
  ).jsonDefaults.setDiagnosticsOptions,
)

beforeEach(() => {
  setDiagnosticsOptions.mockClear()
})

describe('SETTINGS_JSON_SCHEMA', () => {
  it('rejects unknown top-level keys via additionalProperties: false', () => {
    expect(SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false)
  })

  it('constrains locale to exactly en and zh-Hant', () => {
    expect(SETTINGS_JSON_SCHEMA.properties.locale.enum).toEqual(['en', 'zh-Hant'])
  })

  it('clamps every font size to the 8-32 px range', () => {
    const { ui, terminal, editor } = SETTINGS_JSON_SCHEMA.properties.appearance.properties
    for (const font of [ui, terminal, editor]) {
      expect(font.properties.size.minimum).toBe(8)
      expect(font.properties.size.maximum).toBe(32)
    }
  })

  it('constrains behavior.cursorStyle to exactly block, underline and bar', () => {
    expect(SETTINGS_JSON_SCHEMA.properties.behavior.properties.cursorStyle.enum).toEqual([
      'block',
      'underline',
      'bar',
    ])
  })
})

describe('registerSettingsSchema', () => {
  it('resolves the settings path via the pine bridge before registering', async () => {
    await registerSettingsSchema()
    expect(window.pine.settings.path).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.pine.settings.path).mock.invocationCallOrder[0]).toBeLessThan(
      setDiagnosticsOptions.mock.invocationCallOrder[0],
    )
  })

  it('registers the exported schema with Monaco keyed to the settings file URI', async () => {
    vi.mocked(window.pine.settings.path).mockResolvedValue('/custom/settings.json')
    await registerSettingsSchema()

    expect(setDiagnosticsOptions).toHaveBeenCalledTimes(1)
    const options = setDiagnosticsOptions.mock.calls[0][0] as {
      validate: boolean
      allowComments: boolean
      schemas: { uri: string; fileMatch: string[]; schema: unknown }[]
    }
    expect(options.validate).toBe(true)
    expect(options.allowComments).toBe(false)
    expect(options.schemas).toHaveLength(1)
    expect(options.schemas[0].uri).toBe('pine://settings-schema')
    expect(options.schemas[0].fileMatch).toEqual(['file:///custom/settings.json'])
    expect(options.schemas[0].schema).toBe(SETTINGS_JSON_SCHEMA)
  })
})
