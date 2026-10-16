export function journalLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .slice(0, -1)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
