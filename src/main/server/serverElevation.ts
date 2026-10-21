import type {
  ElevationMethod,
  ElevationPollResult,
  ElevationStartResult,
  ServerActionResult,
  ServerApprovalsResult,
} from '../../shared/server/serverApi'
import { failureOf, type ServerAccount } from './serverAccount'
import { ServerError } from './serverClient'

type ElevationAccount = Pick<ServerAccount, 'authed' | 'signer'>

type Pending = { kind: 'approval'; approvalId: string } | { kind: 'github'; flowId: string }

const APPROVAL_EXPIRED = 'expired'

export class ServerElevation {
  private pending: Pending | null = null

  constructor(private readonly account: ElevationAccount) {}

  async start(method: ElevationMethod): Promise<ElevationStartResult> {
    await this.cancel()
    try {
      if (method === 'github') {
        const flow = await this.account.authed((token, routes) => routes.githubElevation(token))
        this.pending = { kind: 'github', flowId: flow.flowId }
        return {
          ok: true,
          kind: 'github',
          userCode: flow.userCode,
          verificationUri: flow.verificationUri,
        }
      }
      const headers = this.account.signer().stamped('elevate')
      const { approvalId } = await this.account.authed((token, routes) =>
        routes.requestApproval(token, headers),
      )
      this.pending = { kind: 'approval', approvalId }
      return { ok: true, kind: 'approval' }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  async poll(): Promise<ElevationPollResult> {
    const pending = this.pending
    if (!pending) return { state: 'error', error: 'failed' }
    try {
      const done = await this.account.authed(async (token, routes) => {
        if (pending.kind === 'github') {
          const polled = await routes.githubElevationPoll(token, pending.flowId)
          return polled.elevatedUntil !== undefined
        }
        return (await routes.approvalStatus(token, pending.approvalId)).status === 'approved'
      })
      if (!done) return { state: 'pending' }
      this.pending = null
      return { state: 'done' }
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) {
        this.pending = null
        return { state: 'error', error: APPROVAL_EXPIRED }
      }
      return { state: 'error', error: failureOf(error) }
    }
  }

  async cancel(): Promise<void> {
    const pending = this.pending
    this.pending = null
    if (pending?.kind !== 'approval') return
    try {
      await this.account.authed((token, routes) => routes.cancelApproval(token, pending.approvalId))
    } catch {}
  }

  async approvals(): Promise<ServerApprovalsResult> {
    try {
      const { approvals } = await this.account.authed((token, routes) => routes.approvals(token))
      return {
        ok: true,
        approvals: approvals.map((a) => ({
          id: a.id,
          deviceName: a.deviceName,
          deviceCreatedAt: a.deviceCreatedAt,
          createdAt: a.createdAt,
          expiresAt: a.expiresAt,
        })),
      }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  async approve(approvalId: string): Promise<ServerActionResult> {
    try {
      await this.account.authed(async (token, routes) => {
        const { approvals } = await routes.approvals(token)
        const found = approvals.find((a) => a.id === approvalId)
        if (!found) throw new ServerError(404, 'not-found')
        const headers = this.account.signer().approve(found.id, found.deviceId)
        await routes.approve(token, found.id, headers)
      })
      return { ok: true }
    } catch (error) {
      if (error instanceof ServerError && error.status === 404) {
        return { ok: false, error: APPROVAL_EXPIRED }
      }
      return { ok: false, error: failureOf(error) }
    }
  }
}
