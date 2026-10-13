import {
  type SandboxViolation,
  type SandboxViolationKind,
  type SandboxViolationReason,
  checkDomainPattern,
} from '../../shared/sandbox/sandbox'

export const VIOLATIONS_PER_WORKSPACE = 200
export const VIOLATION_TEXT_MAX = 400

export type ParsedViolation = Pick<
  SandboxViolation,
  'kind' | 'target' | 'reason' | 'detail' | 'allowHost'
>

const NETWORK = /^deny network-outbound (.+):(\d{1,5}) \((.*)\)$/
const REQUEST = /^deny http-request (\S+) (\S+) \((.*)\)$/
const WRITE = /^deny (\S+) (\/.*)$/
const SEATBELT = /^\S+\(\d+\) deny\(\d+\) (\S+) (.+)$/

function seatbeltKind(operation: string): SandboxViolationKind {
  if (operation.startsWith('file-read')) return 'read'
  if (operation.startsWith('file-write')) return 'write'
  return operation.startsWith('network') ? 'network' : 'other'
}

const NETWORK_REASONS: Record<string, SandboxViolationReason> = {
  'host is not on the allow list': 'not-allowed',
  'host is on the deny list': 'blocked',
  'user denied': 'refused',
}

const ALLOWABLE: readonly SandboxViolationReason[] = ['not-allowed', 'refused']

function clean(text: string): string {
  return [...text]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .slice(0, VIOLATION_TEXT_MAX)
}

function networkReason(text: string): SandboxViolationReason {
  const known = NETWORK_REASONS[text]
  if (known) return known
  return text.startsWith('resolved to ') ? 'address' : 'other'
}

export function parseViolationLine(raw: string): ParsedViolation {
  const line = clean(raw.trim())
  const network = NETWORK.exec(line)
  if (network) {
    const host = network[1]
    const reason = networkReason(network[3])
    const allowable = ALLOWABLE.includes(reason) && checkDomainPattern(host).ok
    return {
      kind: 'network',
      target: `${host}:${network[2]}`,
      reason,
      detail: reason === 'other' || reason === 'address' ? network[3] : '',
      ...(allowable ? { allowHost: host.toLowerCase() } : {}),
    }
  }
  const request = REQUEST.exec(line)
  if (request) {
    return { kind: 'network', target: request[2], reason: 'request', detail: request[3] }
  }
  const write = WRITE.exec(line)
  if (write) return { kind: 'write', target: write[2], reason: 'outside', detail: write[1] }
  const seatbelt = SEATBELT.exec(line)
  if (seatbelt) {
    return {
      kind: seatbeltKind(seatbelt[1]),
      target: seatbelt[2],
      reason: 'other',
      detail: seatbelt[1],
    }
  }
  return { kind: 'other', target: line, reason: 'other', detail: '' }
}

function keyOf(kind: SandboxViolationKind, target: string, detail: string): string {
  return `${kind}\u0000${target}\u0000${detail}`
}

export class ViolationLog {
  private readonly entries = new Map<string, Map<string, SandboxViolation>>()

  constructor(private readonly now: () => number = Date.now) {}

  add(workspaceId: string, parsed: ParsedViolation): void {
    if (!parsed.target) return
    const list = this.entries.get(workspaceId) ?? new Map<string, SandboxViolation>()
    const key = keyOf(parsed.kind, parsed.target, parsed.detail)
    const count = (list.get(key)?.count ?? 0) + 1
    list.delete(key)
    list.set(key, { ...parsed, id: key, count, last: this.now() })
    while (list.size > VIOLATIONS_PER_WORKSPACE) {
      const oldest = list.keys().next().value
      if (oldest === undefined) break
      list.delete(oldest)
    }
    this.entries.set(workspaceId, list)
  }

  list(workspaceId: string): SandboxViolation[] {
    return [...(this.entries.get(workspaceId)?.values() ?? [])].reverse().map((v) => ({ ...v }))
  }

  clear(workspaceId: string): void {
    this.entries.delete(workspaceId)
  }
}

export type WriteRefusal = 'outside' | 'read-only'

export function recordViolations(
  log: ViolationLog,
  writeRefusal: (path: string) => WriteRefusal | null,
  workspaceId: string,
  lines: readonly string[],
): void {
  for (const line of lines) {
    const parsed = parseViolationLine(line)
    if (parsed.reason !== 'outside') {
      log.add(workspaceId, parsed)
      continue
    }
    const reason = writeRefusal(parsed.target)
    if (reason) log.add(workspaceId, { ...parsed, reason })
  }
}
