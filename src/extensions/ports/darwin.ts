import type { ProcEntry } from './procfs'

export function parsePsTable(text: string): ProcEntry[] {
  const out: ProcEntry[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const comm = m[5].slice(m[5].lastIndexOf('/') + 1)
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgrp: Number(m[3]),
      tpgid: Number(m[4]),
      comm,
    })
  }
  return out
}

export function parseLsofListeners(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      continue
    }
    if (!line.startsWith('n') || !Number.isInteger(pid) || pid <= 0) continue
    const port = Number(line.slice(line.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    const list = out.get(pid) ?? []
    if (!list.includes(port)) list.push(port)
    out.set(pid, list)
  }
  return out
}

export function splitPsArgs(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}
