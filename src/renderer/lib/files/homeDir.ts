let home: string | null = null

export function homeDir(): string | null {
  return home
}

export async function loadHomeDir(): Promise<void> {
  try {
    home = (await window.ostia.info()).home || null
  } catch {
    home = null
  }
}
