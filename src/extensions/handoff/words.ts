export const WORDS_MAX = 6
const WORD_MAX = 40
export const TOPIC_MAX = 300

const WORD_STRIP = /[^\p{L}\p{N}_.#/-]/gu

export function searchWords(argv: readonly string[]): string[] {
  const words = argv
    .join(' ')
    .split(/\s+/)
    .map((w) => w.replace(WORD_STRIP, '').replace(/^-+/, '').slice(0, WORD_MAX).toLowerCase())
    .filter((w) => w.length >= 2)
  return [...new Set(words)].slice(0, WORDS_MAX)
}

export function cleanTopic(argv: readonly string[]): string {
  let out = ''
  for (const ch of argv.join(' ')) {
    const code = ch.codePointAt(0) ?? 0
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
    out += control || code === 0x2028 || code === 0x2029 ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX)
}
