import type { FakeServer, Handler } from './fakeServer'

export function accountRoutes(server: FakeServer): Array<[string, RegExp, Handler]> {
  const revoke: Handler = (req, res, _body, _raw, [target]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const { device } = auth
    if (target !== device.id) {
      server.error(res, 403, 'not-this-device')
      return
    }
    if (
      !server.signed(
        req,
        res,
        device,
        (s) => `ostia-server/revoke/v2\n${device.id}\n${s}\n${device.id}`,
        true,
      )
    ) {
      return
    }
    server.removeDevice(device)
    res.writeHead(204).end()
  }

  return [['DELETE', /^\/v1\/devices\/([^/]+)$/, revoke]]
}
