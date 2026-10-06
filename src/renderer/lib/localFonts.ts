interface LocalFontData {
  family: string
}

type QueryLocalFonts = () => Promise<LocalFontData[]>

let families: Promise<string[]> | null = null

function bundledFamilies(): string[] {
  if (!document.fonts) return []
  return [...document.fonts].map((face) => face.family.replace(/^["']|["']$/g, ''))
}

function sortedFamilies(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

async function queryFamilies(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  const installed = query ? (await query()).map((f) => f.family) : []
  return sortedFamilies([...bundledFamilies(), ...installed])
}

export function localFontFamilies(): Promise<string[]> {
  families ??= queryFamilies().then(
    (names) => {
      if (names.length === 0) families = null
      return names
    },
    () => {
      families = null
      return sortedFamilies(bundledFamilies())
    },
  )
  return families
}
