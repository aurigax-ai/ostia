import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITIES } from '../../shared/capabilities'
import { commands } from '../commands/registry'
import { langFor, setSettingsFile } from '../monaco/language'
import { settingsJsonDefaults } from '../monaco/settingsLanguage'
import { useSettingsStore } from '../stores/settingsStore'
import { registerSettingsSchema } from './registerSettingsSchema'
import { SETTINGS_JSON_SCHEMA } from './settingsSchema'

vi.mock('../monaco/setup', () => ({
  monaco: { Uri: { file: (p: string) => ({ toString: () => `file://${p}` }) } },
}))
vi.mock('../monaco/settingsLanguage', () => ({
  settingsJsonDefaults: { setDiagnosticsOptions: vi.fn() },
}))

const setDiagnosticsOptions = vi.mocked(settingsJsonDefaults.setDiagnosticsOptions)

beforeEach(() => {
  setDiagnosticsOptions.mockClear()
})

describe('SETTINGS_JSON_SCHEMA', () => {
  it('rejects unknown top-level keys via additionalProperties: false', () => {
    expect(SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false)
  })

  describe('saved settings.json', () => {
    const initial = useSettingsStore.getState()

    afterEach(() => {
      useSettingsStore.setState(initial, true)
      vi.useRealTimers()
    })

    it('describes every top-level key the settings store writes', async () => {
      vi.useFakeTimers()
      vi.mocked(window.pine.fs.write).mockClear()
      useSettingsStore.getState().setExtensionSettings('git', { pollSeconds: 30 })
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
      const described = Object.keys(SETTINGS_JSON_SCHEMA.properties)
      expect(Object.keys(written).filter((key) => !described.includes(key))).toEqual([])
      expect(written.extensionSettings).toEqual({ git: { pollSeconds: 30 } })
    })
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

  it('constrains appearance.motion to exactly system, reduced and full', () => {
    expect(SETTINGS_JSON_SCHEMA.properties.appearance.properties.motion.enum).toEqual([
      'system',
      'reduced',
      'full',
    ])
  })

  it('constrains behavior.cursorStyle to exactly block, underline and bar', () => {
    expect(SETTINGS_JSON_SCHEMA.properties.behavior.properties.cursorStyle.enum).toEqual([
      'block',
      'underline',
      'bar',
    ])
  })

  it('lets keybindings map a command id to a chord string or null', () => {
    const { keybindings } = SETTINGS_JSON_SCHEMA.properties
    expect(Object.keys(keybindings.properties)).toContain('workspace.goto')
    expect(keybindings.additionalProperties.type).toEqual(['string', 'null'])
  })

  it('offers gateway among capabilities.grants, and only recognized capabilities', () => {
    const grants = SETTINGS_JSON_SCHEMA.properties.capabilities.properties.grants.items.enum
    expect(grants).toContain('gateway')
    for (const cap of grants) expect(ALL_CAPABILITIES).toContain(cap)
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
    expect(options.schemas[0].schema).toMatchObject({
      additionalProperties: false,
      properties: { locale: SETTINGS_JSON_SCHEMA.properties.locale },
    })
  })

  it('gives the settings file, and only it, the language Monaco’s own JSON features always serve', async () => {
    vi.mocked(window.pine.settings.path).mockResolvedValue('/custom/settings.json')
    await registerSettingsSchema()
    expect(langFor('/custom/settings.json')).toBe('pine-settings')
    expect(langFor('/custom/other.json')).toBe('json')
    expect(langFor('/elsewhere/settings.json')).toBe('json')
    setSettingsFile(null)
    expect(langFor('/custom/settings.json')).toBe('json')
  })

  it('lists every default chord and each registered palette command under keybindings', async () => {
    commands.register({ id: 'test.bindable', title: 'Bindable', run: () => {} })
    commands.register({ id: 'test.hidden', title: 'Hidden', hidden: true, run: () => {} })
    try {
      await registerSettingsSchema()
      const options = setDiagnosticsOptions.mock.calls[0][0] as {
        schemas: { schema: { properties: { keybindings: { properties: object } } } }[]
      }
      const ids = Object.keys(options.schemas[0].schema.properties.keybindings.properties)
      expect(ids).toEqual(expect.arrayContaining(['palette.toggle', 'copy', 'test.bindable']))
      expect(ids).not.toContain('test.hidden')
    } finally {
      commands.unregister('test.bindable')
      commands.unregister('test.hidden')
    }
  })
})
