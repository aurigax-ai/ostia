export function decodeCommandLine(encoded: string): string {
  return encoded.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, esc: string, hex?: string) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : esc,
  )
}
