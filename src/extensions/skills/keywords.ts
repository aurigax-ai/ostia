const STOPWORDS = new Set(
  `a an the to of in on for and or is are was were be been it its this that these those with you your i we me my our
  please can could would will just then than so as at by from up out do does did have has had into over about
  there here what which who how when where why also very more most some any all they them their he she him her
  no not never don't dont doesn't didn't always again stop instead prefer rather avoid without told said last time every each
  code file files use using used add make change fix write run get set new thing need want like`
    .split(/\s+/)
    .filter(Boolean),
)

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu
const HAN_RUN = /\p{Script=Han}+/gu

function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

function hanTokens(run: string): string[] {
  const chars = [...run]
  if (chars.length === 1) return chars
  return chars.slice(0, -1).map((c, i) => c + chars[i + 1])
}

export function keywords(text: string): Set<string> {
  const folded = text.normalize('NFKC').toLowerCase()
  const found = new Set<string>()
  for (const run of folded.match(HAN_RUN) ?? []) {
    for (const token of hanTokens(run)) found.add(token)
  }
  for (const word of folded.replace(HAN_RUN, ' ').match(WORD) ?? []) {
    const token = stem(word.replace(/^['_-]+|['_-]+$/g, ''))
    if (token.length >= 2 && !STOPWORDS.has(token)) found.add(token)
  }
  return found
}

export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

export function containment(inner: ReadonlySet<string>, outer: ReadonlySet<string>): number {
  if (inner.size === 0) return 0
  let shared = 0
  for (const word of inner) if (outer.has(word)) shared += 1
  return shared / inner.size
}
