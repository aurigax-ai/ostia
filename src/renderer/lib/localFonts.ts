interface LocalFontData {
  family: string
}

type QueryLocalFonts = () => Promise<LocalFontData[]>

let families: Promise<string[]> | null = null

function bundledFamilies(): string[] {
  if (!document.fonts) return []
  return [...document.fonts].map((face) => face.family.replace(/^["']|["']$/g, ''))
}

async function queryFamilies(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  const installed = query ? (await query()).map((f) => f.family) : []
  return [...new Set([...bundledFamilies(), ...installed])].sort((a, b) => a.localeCompare(b))
}

export function localFontFamilies(): Promise<string[]> {
  families ??= queryFamilies().catch(() => {
    families = null
    return []
  })
  return families
}
