import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'

const hosts = new Set(['registry.npmjs.org', 'api.osv.dev'])
const port = process.env.OSTIA_FAKE_REGISTRY_PORT

const realLookup = dns.lookup
dns.lookup = (hostname, options, callback) => {
  if (!hosts.has(hostname)) return realLookup(hostname, options, callback)
  const done = typeof options === 'function' ? options : callback
  if (typeof options === 'object' && options.all) {
    done(null, [{ address: '127.0.0.1', family: 4 }])
  } else {
    done(null, '127.0.0.1', 4)
  }
}
syncBuiltinESMExports()

const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (hosts.has(url.hostname)) url.port = port
  return realFetch(url, init)
}
