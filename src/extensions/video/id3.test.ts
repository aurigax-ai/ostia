import { describe, expect, it } from 'vitest'
import { ID3_HEADER_BYTES, id3TagLength, parseId3 } from './id3'

function synchsafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]
}

function frame(id: string, body: number[], version: 3 | 4): number[] {
  const size =
    version === 4
      ? synchsafe(body.length)
      : [
          (body.length >> 24) & 255,
          (body.length >> 16) & 255,
          (body.length >> 8) & 255,
          body.length & 255,
        ]
  return [...[...id].map((c) => c.charCodeAt(0)), ...size, 0, 0, ...body]
}

function tag(frames: number[][], version: 3 | 4): Uint8Array {
  const body = frames.flat()
  return new Uint8Array([0x49, 0x44, 0x33, version, 0, 0, ...synchsafe(body.length), ...body])
}

const text = (value: string): number[] => [3, ...new TextEncoder().encode(value)]

describe('id3TagLength', () => {
  it('reads the length of a tag from its header', () => {
    expect(id3TagLength(tag([frame('TIT2', text('a'), 4)], 4).slice(0, ID3_HEADER_BYTES))).toBe(
      ID3_HEADER_BYTES + 12,
    )
  })

  it('is zero for data that is not a tag', () => {
    expect(id3TagLength(new Uint8Array(10))).toBe(0)
    expect(id3TagLength(new Uint8Array(3))).toBe(0)
  })
})

describe('parseId3', () => {
  it('reads title, artist and album in both versions', () => {
    for (const version of [3, 4] as const) {
      const parsed = parseId3(
        tag(
          [
            frame('TIT2', text('Standup recap'), version),
            frame('TPE1', text('Team sync'), version),
            frame('TALB', text('Weekly'), version),
          ],
          version,
        ),
      )
      expect(parsed).toEqual({ title: 'Standup recap', artist: 'Team sync', album: 'Weekly' })
    }
  })

  it('decodes UTF-16 text with a byte order mark', () => {
    const utf16 = [1, 0xff, 0xfe, ...[...'Hi'].flatMap((c) => [c.charCodeAt(0), 0])]
    expect(parseId3(tag([frame('TIT2', utf16, 4)], 4)).title).toBe('Hi')
  })

  it('reads an embedded picture', () => {
    const mime = [...'image/png'].map((c) => c.charCodeAt(0))
    const picture = [0, ...mime, 0, 3, 0, 1, 2, 3]
    const parsed = parseId3(tag([frame('APIC', picture, 4)], 4))
    expect(parsed.cover?.mime).toBe('image/png')
    expect([...(parsed.cover?.data ?? [])]).toEqual([1, 2, 3])
  })

  it('ignores a picture type that cannot be shown', () => {
    const mime = [...'image/x-weird'].map((c) => c.charCodeAt(0))
    expect(parseId3(tag([frame('APIC', [0, ...mime, 0, 3, 0, 9], 4)], 4)).cover).toBeUndefined()
  })

  it('returns nothing for other data and stops at a frame that overruns the tag', () => {
    expect(parseId3(new Uint8Array([1, 2, 3]))).toEqual({})
    const broken = tag([frame('TIT2', text('ok'), 4)], 4)
    broken[broken.length - 6] = 0x7f
    expect(parseId3(broken)).toEqual({})
  })
})
