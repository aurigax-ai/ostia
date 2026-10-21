import { randomBytes } from 'node:crypto'
import type { FakeDevice, FakeServer, Handler } from './fakeServer'

const INVITE_TTL_MS = 600_000
const APPROVAL_TTL_MS = 300_000

interface FakeApproval {
  id: string
  deviceId: string
  token: string
  createdAt: number
  expiresAt: number
  approvedUntil: number
}

interface GithubElevationFlow {
  token: string
  polls: number
}

const id = (): string => randomBytes(9).toString('base64url')

function lookupDevice(server: FakeServer, accountId: string, target: string): FakeDevice | null {
  const device = server.devices.get(target)
  return device && device.accountId === accountId ? device : null
}

export function accountRoutes(server: FakeServer): Array<[string, RegExp, Handler]> {
  const approvals = new Map<string, FakeApproval>()
  const flows = new Map<string, GithubElevationFlow>()
  const old = (device: FakeDevice): boolean =>
    server.now() - device.createdAt >= server.approverMinAgeMs

  const invite: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const { device, session } = auth
    if (
      !server.signed(req, res, device, (s) => `ostia-server/invite/v1\n${device.id}\n${s}`, true)
    ) {
      return
    }
    const open = [...server.deviceInvites.values()].filter(
      (i) => i.accountId === device.accountId && i.expiresAt > server.now(),
    ).length
    const count = server.accountDevices(device.accountId).length + open
    const elevated = server.elevated(session)
    if (count >= 2 && !elevated) {
      server.error(res, 403, 'elevation-required')
      return
    }
    const code = id()
    const expiresAt = server.now() + INVITE_TTL_MS
    server.deviceInvites.set(code, { accountId: device.accountId, elevated, expiresAt })
    server.reply(res, 201, { code, expiresAt })
  }

  const seen: Handler = (req, res, body, _raw, [target]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const { device } = auth
    const other = lookupDevice(server, device.accountId, target ?? '')
    if (!other) {
      server.error(res, 404, 'unknown-device')
      return
    }
    const message = `ostia-server/seen/v1\n${device.id}\n${other.id}`
    const signature = String(body.sig ?? '')
    if (!signature) {
      server.error(res, 403, 'device-signature-required')
      return
    }
    if (!server.verifySignature(device, message, signature)) {
      server.error(res, 403, 'bad-signature')
      return
    }
    server.acknowledged.add(`${device.id}:${other.id}`)
    res.writeHead(204).end()
  }

  const revoke: Handler = (req, res, _body, _raw, [target]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const { device, session } = auth
    const other = lookupDevice(server, device.accountId, target ?? '')
    if (!other) {
      server.error(res, 404, 'unknown-device')
      return
    }
    if (
      !server.signed(
        req,
        res,
        device,
        () => `ostia-server/revoke/v1\n${device.id}\n${other.id}`,
        false,
      )
    ) {
      return
    }
    const probation = !old(other) && other.order > device.order && other.id !== device.id
    const older = server
      .accountDevices(device.accountId)
      .some((d) => d.id !== device.id && d.order < device.order)
    const free = other.id === device.id ? older : probation
    if (!free && !server.elevated(session)) {
      server.error(res, 403, 'elevation-required')
      return
    }
    server.removeDevice(other)
    res.writeHead(204).end()
  }

  const elevation: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    server.reply(res, 200, {
      elevatedUntil: server.elevated(auth.session) ? auth.session.elevatedUntil : 0,
    })
  }

  const requestApproval: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const { device, token } = auth
    if (
      !server.signed(req, res, device, (s) => `ostia-server/elevate/v1\n${device.id}\n${s}`, true)
    ) {
      return
    }
    if (server.accountDevices(device.accountId).length < 2) {
      server.error(res, 409, 'no-second-device')
      return
    }
    const approval = {
      id: id(),
      deviceId: device.id,
      token,
      createdAt: server.now(),
      expiresAt: server.now() + APPROVAL_TTL_MS,
      approvedUntil: 0,
    }
    approvals.set(approval.id, approval)
    server.reply(res, 201, { approvalId: approval.id, expiresAt: approval.expiresAt })
  }

  const listApprovals: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const mine = auth.device
    const list = [...approvals.values()]
      .filter((a) => a.expiresAt > server.now() && a.approvedUntil === 0 && a.deviceId !== mine.id)
      .flatMap((a) => {
        const requester = server.devices.get(a.deviceId)
        return requester && requester.accountId === mine.accountId
          ? [
              {
                id: a.id,
                deviceId: a.deviceId,
                deviceName: requester.name,
                deviceCreatedAt: requester.createdAt,
                createdAt: a.createdAt,
                expiresAt: a.expiresAt,
              },
            ]
          : []
      })
    server.reply(res, 200, { approvals: list })
  }

  const approve: Handler = (req, res, _body, _raw, [approvalId]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const approver = auth.device
    const approval = approvals.get(approvalId ?? '')
    const requester = approval ? server.devices.get(approval.deviceId) : undefined
    if (!approval || !requester || requester.accountId !== approver.accountId) {
      server.error(res, 404, 'not-found')
      return
    }
    const message = `ostia-server/approve/v1\n${approver.id}\n${approval.id}\n${requester.id}`
    if (!server.signed(req, res, approver, () => message, false)) return
    if (requester.id === approver.id) {
      server.error(res, 403, 'forbidden')
      return
    }
    if (!old(approver)) {
      server.error(res, 403, 'device-too-new')
      return
    }
    if (!old(requester)) {
      server.error(res, 403, 'requester-too-new')
      return
    }
    const session = server.sessions.get(approval.token)
    if (session) approval.approvedUntil = server.elevate(session)
    res.writeHead(204).end()
  }

  const approvalStatus: Handler = (req, res, _body, _raw, [approvalId]) => {
    const auth = server.authed(req, res)
    const approval = approvals.get(approvalId ?? '')
    if (!auth) return
    if (!approval || approval.deviceId !== auth.device.id) {
      server.error(res, 404, 'not-found')
      return
    }
    server.reply(
      res,
      200,
      approval.approvedUntil > 0
        ? { status: 'approved', elevatedUntil: approval.approvedUntil }
        : { status: 'pending' },
    )
  }

  const cancelApproval: Handler = (req, res, _body, _raw, [approvalId]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const approval = approvals.get(approvalId ?? '')
    if (!approval || approval.deviceId !== auth.device.id) {
      server.error(res, 403, 'forbidden')
      return
    }
    approvals.delete(approval.id)
    res.writeHead(204).end()
  }

  const githubElevation: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    if (auth.device.provider !== 'github') {
      server.error(res, 409, 'not-a-github-account')
      return
    }
    const flowId = id()
    flows.set(flowId, { token: auth.token, polls: 0 })
    server.reply(res, 200, {
      flowId,
      userCode: 'ELEV-1234',
      verificationUri: 'https://github.test/login/device',
      interval: 0,
      expiresIn: 900,
    })
  }

  const githubElevationPoll: Handler = (req, res, body) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const flow = flows.get(String(body.flowId ?? ''))
    if (!flow || flow.token !== auth.token) {
      server.error(res, 404, 'unknown-flow')
      return
    }
    flow.polls += 1
    if (flow.polls <= server.githubPendingPolls) {
      server.reply(res, 202, { status: 'pending', interval: 0 })
      return
    }
    server.reply(res, 200, { elevatedUntil: server.elevate(auth.session) })
  }

  return [
    ['POST', /^\/v1\/devices\/invite$/, invite],
    ['POST', /^\/v1\/devices\/([^/]+)\/seen$/, seen],
    ['DELETE', /^\/v1\/devices\/([^/]+)$/, revoke],
    ['GET', /^\/v1\/auth\/elevation$/, elevation],
    ['POST', /^\/v1\/auth\/elevation\/approval$/, requestApproval],
    ['GET', /^\/v1\/auth\/approvals$/, listApprovals],
    ['POST', /^\/v1\/auth\/approvals\/([^/]+)\/approve$/, approve],
    ['GET', /^\/v1\/auth\/approvals\/([^/]+)$/, approvalStatus],
    ['DELETE', /^\/v1\/auth\/approvals\/([^/]+)$/, cancelApproval],
    ['POST', /^\/v1\/auth\/elevation\/github$/, githubElevation],
    ['POST', /^\/v1\/auth\/elevation\/github\/poll$/, githubElevationPoll],
  ]
}
