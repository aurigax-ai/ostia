export function readPref(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}
