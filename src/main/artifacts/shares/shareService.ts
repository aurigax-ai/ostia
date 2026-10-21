import type { PortableResult } from '../../../shared/artifacts/portable'
import {
  type PublishOptions,
  SHARE_EXPIRIES_SECONDS,
  SHARE_NEVER_EXPIRES,
  SHARE_PASSWORD_MAX,
  SHARE_PASSWORD_MIN,
  type ShareActionResult,
  type ShareAvailability,
  type ShareFailure,
  type ShareFinding,
  type SharesListResult,
  type ShareView,
} from '../../../shared/artifacts/shares'
import type { SecretSpan } from '../../../shared/privacy/redaction'
import { failureOf, type ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import type { ShareCreated, ShareRow } from '../../server/serverRoutes'
import {
  deriveShareKey,
  encryptShare,
  newFragmentKey,
  newSalt,
  SHARE_OVERHEAD,
  shareLink,
} from './shareCrypto'
import type { ShareRecord, ShareStore } from './shareStore'

const FINDINGS_MAX = 20
const MASK_REVEALED = 3
const MASK_MIN_LENGTH = 9

export interface ShareServiceDeps {
  account: Pick<ServerAccount, 'signedIn' | 'authed' | 'unauthed' | 'fetchInfo' | 'baseUrl'>
  store: ShareStore
  scan: (text: string) => Promise<SecretSpan[]>
  writeClipboard: (text: string) => void
  now?: () => number
}

export interface PublishSource {
  file: string
  source: string
  name: string
}

type Ready = Extract<ShareAvailability, { state: 'ready' }>

const UNAVAILABLE_REASON = {
  'signed-out': 'signed-out',
  off: 'publish-off',
  unreachable: 'unreachable',
  unavailable: 'unavailable',
} as const

function maskOf(value: string): string {
  return value.length < MASK_MIN_LENGTH ? '…' : `${value.slice(0, MASK_REVEALED)}…`
}

export function findingsOf(text: string, spans: readonly SecretSpan[]): ShareFinding[] {
  return [...spans]
    .sort((a, b) => a.start - b.start)
    .slice(0, FINDINGS_MAX)
    .map((span) => ({
      kind: span.kind,
      line: text.slice(0, span.start).split('\n').length,
      masked: maskOf(text.slice(span.start, span.end)),
    }))
}

function optionsProblem(options: PublishOptions, ready: Ready): PortableResult | null {
  const bad: PortableResult = { ok: false, reason: 'bad-options' }
  const expiries: readonly number[] = SHARE_EXPIRIES_SECONDS
  if (options.expiresInSeconds === SHARE_NEVER_EXPIRES) {
    if (!ready.allowNever) return { ok: false, reason: 'never-off' }
  } else if (!expiries.includes(options.expiresInSeconds)) return bad
  if (options.mode === 'public' && !ready.allowPublic) return { ok: false, reason: 'public-off' }
  if (options.mode === 'password') {
    const length = Array.from(options.password).length
    if (length < SHARE_PASSWORD_MIN || length > SHARE_PASSWORD_MAX) return bad
  }
  return null
}

function publishFailure(error: unknown): PortableResult {
  if (error instanceof ServerError) {
    if (error.code === 'public-disabled') return { ok: false, reason: 'public-off' }
    if (error.code === 'publish-disabled') return { ok: false, reason: 'publish-off' }
    if (error.status === 413) return { ok: false, reason: 'too-large' }
  }
  const failure = failureOf(error)
  if (failure === 'quota') return { ok: false, reason: 'quota' }
  if (failure === 'unreachable' || failure === 'no-server') {
    return { ok: false, reason: 'unreachable' }
  }
  if (failure === 'not-signed-in') return { ok: false, reason: 'signed-out' }
  return { ok: false, reason: 'failed' }
}

function listFailure(error: unknown): ShareFailure {
  const failure = failureOf(error)
  if (failure === 'not-signed-in' || failure === 'no-server') return 'signed-out'
  return failure === 'unreachable' ? 'unreachable' : 'failed'
}

export class ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  async availability(): Promise<ShareAvailability> {
    if (!this.deps.account.signedIn()) return { state: 'signed-out' }
    if (!this.deps.store.available()) return { state: 'unavailable' }
    try {
      const info = await this.deps.account.fetchInfo()
      if (!info.modules.publish) return { state: 'off' }
      return {
        state: 'ready',
        allowNever: info.limits?.allowNever === true,
        allowPublic: info.limits?.allowPublic === true,
        maxBytes: info.limits?.shareMaxBytes ?? Number.MAX_SAFE_INTEGER,
      }
    } catch {
      return { state: 'unreachable' }
    }
  }

  async publish(
    { file, source, name }: PublishSource,
    options: PublishOptions,
  ): Promise<PortableResult> {
    const available = await this.availability()
    if (available.state !== 'ready')
      return { ok: false, reason: UNAVAILABLE_REASON[available.state] }
    const refused = optionsProblem(options, available)
    if (refused) return refused
    const plain = Buffer.from(file, 'utf8')
    const size = options.mode === 'public' ? plain.length : plain.length + SHARE_OVERHEAD
    if (size > available.maxBytes) return { ok: false, reason: 'too-large' }
    const scanned = await this.scanned(file)
    if (!Array.isArray(scanned)) return scanned
    if (scanned.length > 0 && !options.acceptFindings) {
      return { ok: false, reason: 'findings', findings: scanned }
    }
    return this.upload({ source, name }, options, plain, size)
  }

  private async scanned(file: string): Promise<ShareFinding[] | PortableResult> {
    try {
      return findingsOf(file, await this.deps.scan(file))
    } catch {
      return { ok: false, reason: 'scan-failed' }
    }
  }

  private async upload(
    meta: { source: string; name: string },
    options: PublishOptions,
    plain: Buffer,
    size: number,
  ): Promise<PortableResult> {
    const salt = options.mode === 'password' ? newSalt() : undefined
    const fragment =
      options.mode === 'link' || (options.mode === 'password' && options.withLinkKey)
        ? newFragmentKey()
        : undefined
    let created: ShareCreated | null = null
    try {
      created = await this.deps.account.authed((token, routes) =>
        routes.createShare(token, {
          mode: options.mode,
          size,
          expiresInSeconds: options.expiresInSeconds,
          ...(salt ? { salt: salt.toString('base64url') } : {}),
        }),
      )
      const body =
        options.mode === 'public'
          ? plain
          : encryptShare(
              created.id,
              await deriveShareKey({
                mode: options.mode,
                password: options.password,
                salt,
                fragment,
              }),
              plain,
            )
      const path = this.uploadPath(created.uploadUrl)
      const bytes = new Uint8Array(body)
      await this.deps.account.authed((token, routes) => routes.uploadShare(token, path, bytes))
    } catch (error) {
      if (created) await this.discard(created.id, created.deleteToken)
      return publishFailure(error)
    }
    const record: ShareRecord = {
      id: created.id,
      mode: options.mode,
      source: meta.source,
      name: meta.name,
      size,
      url: created.url,
      deleteToken: created.deleteToken,
      linkKey: fragment ? fragment.toString('base64url') : null,
      createdAt: this.now(),
      expiresAt: created.expiresAt,
    }
    this.deps.store.add(record)
    return { ok: true, share: viewOf(record, null) }
  }

  private uploadPath(uploadUrl: string): string {
    const base = this.deps.account.baseUrl()
    const target = new URL(uploadUrl)
    if (!base || new URL(base).origin !== target.origin) {
      throw new ServerError(400, 'bad-upload-url')
    }
    return `${target.pathname}${target.search}`
  }

  private async discard(id: string, deleteToken: string): Promise<void> {
    try {
      await this.deps.account.unauthed((routes) => routes.deleteShare(id, { deleteToken }))
    } catch {}
  }

  async list(): Promise<SharesListResult> {
    if (!this.deps.account.signedIn()) return { ok: false, error: 'signed-out' }
    try {
      const { shares } = await this.deps.account.authed((token, routes) => routes.shares(token))
      const records = new Map(this.deps.store.list().map((record) => [record.id, record]))
      const listed = new Set(shares.map((row) => row.id))
      for (const id of records.keys()) if (!listed.has(id)) this.deps.store.remove(id)
      const views = [...shares]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((row) => viewOf(records.get(row.id) ?? null, row))
      return { ok: true, shares: views }
    } catch (error) {
      return { ok: false, error: listFailure(error) }
    }
  }

  copyLink(id: string): ShareActionResult {
    const record = this.deps.store.get(id)
    if (!record) return { ok: false, error: 'unknown' }
    const key = record.linkKey ? Buffer.from(record.linkKey, 'base64url') : null
    this.deps.writeClipboard(shareLink(record.url, key))
    return { ok: true }
  }

  async remove(id: string): Promise<ShareActionResult> {
    const record = this.deps.store.get(id)
    if (record) {
      const byToken = await this.removeWith(id, { deleteToken: record.deleteToken })
      if (byToken === 'unreachable') return { ok: false, error: 'unreachable' }
      if (byToken === 'done') {
        this.deps.store.remove(id)
        return { ok: true }
      }
    }
    if (!this.deps.account.signedIn()) return { ok: false, error: 'signed-out' }
    const bySession = await this.removeWith(id, 'session')
    if (bySession === 'done') {
      this.deps.store.remove(id)
      return { ok: true }
    }
    return { ok: false, error: bySession === 'unreachable' ? 'unreachable' : 'failed' }
  }

  private async removeWith(
    id: string,
    how: { deleteToken: string } | 'session',
  ): Promise<'done' | 'refused' | 'unreachable'> {
    try {
      if (how === 'session') {
        await this.deps.account.authed((token, routes) => routes.deleteShare(id, { token }))
      } else {
        await this.deps.account.unauthed((routes) => routes.deleteShare(id, how))
      }
      return 'done'
    } catch (error) {
      if (error instanceof ServerError && error.status === 404 && how === 'session') return 'done'
      return failureOf(error) === 'unreachable' ? 'unreachable' : 'refused'
    }
  }
}

function viewOf(record: ShareRecord | null, row: ShareRow | null): ShareView {
  const base = row ?? record
  if (!base) throw new Error('a share view needs a record or a row')
  return {
    id: base.id,
    url: base.url,
    mode: base.mode,
    size: base.size,
    views: row?.views ?? 0,
    expiresAt: base.expiresAt,
    uploaded: row?.uploaded ?? true,
    expired: row?.expired === true,
    name: record?.name ?? null,
    source: record?.source ?? null,
    linkable: record !== null,
  }
}
