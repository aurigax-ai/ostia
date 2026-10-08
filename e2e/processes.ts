import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  fields: string[]
  line: string
}

export function processRows(root: number, columns: string): ProcessRow[] {
  const rows = execFileSync('ps', ['-A', '-o', `pid=,ppid=,${columns}`], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, ...fields] = line.split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), fields, line }
    })
  const kept = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (kept.has(row.ppid) && !kept.has(row.pid)) {
        kept.add(row.pid)
        grew = true
      }
    }
  }
  return rows.filter((row) => kept.has(row.pid))
}
