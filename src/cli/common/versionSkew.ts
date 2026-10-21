import { readFileSync, writeFileSync } from 'node:fs'

export function versionSkewWarning(
  app: string | undefined,
  cli: string | null,
  warned: { read: () => string | undefined; write: (mark: string) => void },
): string | undefined {
  if (!app || !cli || app === cli) return undefined
  const mark = `${app}|${cli}`
  if (warned.read() === mark) return undefined
  warned.write(mark)
  return `ostia: the app runs ${app}, this CLI is ${cli}; restart Ostia`
}

export function skewMarkFile(path: string): {
  read: () => string | undefined
  write: (mark: string) => void
} {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    write: (mark) => {
      try {
        writeFileSync(path, mark)
      } catch {}
    },
  }
}
