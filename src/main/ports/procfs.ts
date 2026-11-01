export interface ListeningSocket {
  port: number
  inode: string
  uid: number
}

export interface ListeningPort {
  port: number
  name?: string
}

export interface SocketHolder {
  name: string | undefined
  inodes: string[]
}

const TCP_LISTEN = '0A'

export function parseNetTcp(text: string): ListeningSocket[] {
  const out: ListeningSocket[] = []
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== TCP_LISTEN) continue
    const local = fields[1]
    const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16)
    const inode = fields[9]
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^\d+$/.test(inode)) continue
    if (inode === '0') continue
    out.push({ port, inode, uid: Number(fields[7]) })
  }
  return out
}

export function socketInode(link: string): string | null {
  const m = /^socket:\[(\d+)\]$/.exec(link)
  return m ? m[1] : null
}

const DELETED_SUFFIX = ' (deleted)'

export function processName(exeLink: string, comm: string | undefined): string | undefined {
  const path = exeLink.endsWith(DELETED_SUFFIX) ? exeLink.slice(0, -DELETED_SUFFIX.length) : exeLink
  return path.slice(path.lastIndexOf('/') + 1) || comm
}

export function sortedPorts(owners: Map<number, string | undefined>): ListeningPort[] {
  return [...owners]
    .sort(([a], [b]) => a - b)
    .map(([port, name]) => (name ? { port, name } : { port }))
}

export function addOwner(
  owners: Map<number, string | undefined>,
  port: number,
  name?: string,
): void {
  if (!owners.get(port)) owners.set(port, name || owners.get(port))
}

export function portsForHolders(
  sockets: ListeningSocket[],
  holders: SocketHolder[],
): ListeningPort[] {
  const holderOf = new Map<string, string | undefined>()
  for (const holder of holders) {
    for (const inode of holder.inodes) if (!holderOf.has(inode)) holderOf.set(inode, holder.name)
  }
  const owners = new Map<number, string | undefined>()
  for (const s of sockets)
    if (holderOf.has(s.inode)) addOwner(owners, s.port, holderOf.get(s.inode))
  return sortedPorts(owners)
}
