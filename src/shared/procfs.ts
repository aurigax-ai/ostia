export interface ProcStat {
  pid: number
  comm: string
  ppid: number
  pgrp: number
  tpgid: number
  ttyNr: number
}

export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close <= open) return null

  const pid = Number(text.slice(0, open).trim())
  const comm = text.slice(open + 1, close)

  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)

  const ppid = Number(fields[1])
  const pgrp = Number(fields[2])
  const tpgid = Number(fields[5])
  const ttyNr = Number(fields[4])

  if (![pid, ppid, pgrp, tpgid, ttyNr].every(Number.isInteger) || pid <= 0) return null

  return { pid, comm, ppid, pgrp, tpgid, ttyNr }
}
