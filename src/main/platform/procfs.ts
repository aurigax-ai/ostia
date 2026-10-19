export interface ProcEntry {
  pid: number
  ppid: number
  pgrp: number
  tpgid: number
  comm: string
}

export function parseProcStat(text: string): ProcEntry | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const comm = text.slice(open + 1, close)
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const ppid = Number(rest[1])
  const pgrp = Number(rest[2])
  const tpgid = Number(rest[5])
  if (![pid, ppid, pgrp, tpgid].every(Number.isInteger) || pid <= 0) return null
  return { pid, ppid, pgrp, tpgid, comm }
}

export function childrenOf(procs: Iterable<ProcEntry>): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const p of procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  return children
}

export function processTree(root: number, children: Map<number, number[]>): number[] {
  const seen = new Set<number>([root])
  const queue = [root]
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return queue
}
