import { structuredPatch } from 'diff'

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
}

export interface DiffSummary {
  lines: DiffLine[]
  added: number
  removed: number
}

export function diffSummary(before: string, after: string): DiffSummary {
  const patch = structuredPatch('a', 'b', before, after, undefined, undefined, { context: 3 })
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    lines.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    })
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
      if (kind === 'add') added += 1
      if (kind === 'del') removed += 1
      lines.push({ kind, text: line })
    }
  }
  return { lines, added, removed }
}
