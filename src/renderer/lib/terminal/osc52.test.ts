import { parseTerminalSettings } from '@/settings/terminalPaneSettings'
import { describe, expect, it, vi } from 'vitest'
import { OSC52_MAX_PAYLOAD, decodeOsc52, registerOsc52 } from './osc52'

const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe('decodeOsc52', () => {
  it('decodes a clipboard write for any selection target as UTF-8 text', () => {
    expect(decodeOsc52(`c;${b64('hello')}`)).toBe('hello')
    expect(decodeOsc52(`;${b64('héllo ✓')}`)).toBe('héllo ✓')
    expect(decodeOsc52(`pc;${b64('two')}`)).toBe('two')
  })

  it('never answers a read query and ignores an empty or malformed payload', () => {
    expect(decodeOsc52('c;?')).toBeNull()
    expect(decodeOsc52('c;')).toBeNull()
    expect(decodeOsc52('c;not base64!')).toBeNull()
    expect(decodeOsc52(b64('no separator'))).toBeNull()
    expect(decodeOsc52(`x;${b64('bad target')}`)).toBeNull()
    expect(decodeOsc52(`c;${btoa('\xff\xfe')}`)).toBeNull()
  })

  it('refuses a payload over the size cap', () => {
    expect(decodeOsc52(`c;${'A'.repeat(OSC52_MAX_PAYLOAD + 4)}`)).toBeNull()
  })
})

describe('registerOsc52', () => {
  const setup = (enabled: boolean, replaying = false) => {
    let handler: ((data: string) => boolean) | null = null
    const term = {
      parser: {
        registerOscHandler: (id: number, fn: (data: string) => boolean) => {
          expect(id).toBe(52)
          handler = fn
          return { dispose: () => undefined }
        },
      },
    } as unknown as Parameters<typeof registerOsc52>[0]
    const write = vi.fn(async (_text: string) => undefined)
    registerOsc52(term, { enabled: () => enabled, replaying: () => replaying, write })
    return { send: (data: string) => handler?.(data), write }
  }

  it('writes the clipboard only while the setting is on and never during a replay', () => {
    const on = setup(true)
    expect(on.send(`c;${b64('copied')}`)).toBe(true)
    expect(on.write).toHaveBeenCalledWith('copied')

    const off = setup(false)
    off.send(`c;${b64('copied')}`)
    expect(off.write).not.toHaveBeenCalled()

    const replay = setup(true, true)
    replay.send(`c;${b64('old')}`)
    expect(replay.write).not.toHaveBeenCalled()
  })

  it('OSC 52 leaves the clipboard alone by default', () => {
    const fresh = setup(parseTerminalSettings(undefined).osc52Write)
    fresh.send(`c;${b64('ostia-osc52-off')}`)
    expect(fresh.write).not.toHaveBeenCalled()
  })
})
