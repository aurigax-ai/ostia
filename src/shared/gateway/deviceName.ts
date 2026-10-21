const DEVICE_NAME_MAX = 64

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function cleanDeviceName(name: unknown): string | null {
  if (typeof name !== 'string' || UNSAFE.test(name)) return null
  const kept = Array.from(graphemes.segment(name.trim()), (g) => g.segment).slice(
    0,
    DEVICE_NAME_MAX,
  )
  return kept.join('').trim() || null
}
