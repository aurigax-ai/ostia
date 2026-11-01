import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function claimReportStem(dir: string, stemOf: (names: readonly string[]) => string): string {
  for (;;) {
    const stem = join(dir, stemOf(readdirSync(dir)))
    try {
      writeFileSync(`${stem}.md`, '', { mode: 0o600, flag: 'wx' })
      return stem
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
