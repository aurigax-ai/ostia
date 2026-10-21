export interface OutlineEntry {
  level: number
  text: string
  slug: string
  element: HTMLElement
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6'

export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

export function outlineOf(article: HTMLElement): OutlineEntry[] {
  const used = new Map<string, number>()
  return [...article.querySelectorAll<HTMLElement>(HEADINGS)].map((element) => {
    const text = (element.textContent ?? '').trim()
    const base = slugOf(text)
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    return {
      level: Number(element.tagName.slice(1)),
      text,
      slug: seen === 0 ? base : `${base}-${seen}`,
      element,
    }
  })
}

export function entryForFragment(
  entries: readonly OutlineEntry[],
  fragment: string,
): OutlineEntry | null {
  let wanted = fragment
  try {
    wanted = decodeURIComponent(fragment)
  } catch {}
  const slug = wanted.toLowerCase()
  return entries.find((entry) => entry.slug === slug) ?? null
}
