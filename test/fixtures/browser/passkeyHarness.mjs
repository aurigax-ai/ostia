import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const input = JSON.parse(readFileSync(0, 'utf8'))
const calls = []
const info = []
const proto = {
  create(options) {
    calls.push({ name: 'create', options })
    return Promise.resolve('created')
  },
  get(options) {
    calls.push({ name: 'get', options })
    return Promise.resolve('got')
  },
}
const credentials = Object.create(proto)
const PublicKeyCredential = {
  ...(input.capabilities
    ? { getClientCapabilities: () => Promise.resolve({ ...input.capabilities }) }
    : {}),
  ...(input.uvpaa === undefined
    ? {}
    : { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(input.uvpaa) }),
}
const sandbox = {
  navigator: input.noCredentials ? {} : { credentials },
  PublicKeyCredential,
  DOMException,
  console: { info: (message) => info.push(message) },
}
sandbox.window = sandbox
runInNewContext(input.script, sandbox)

const steps = []
for (const step of input.steps ?? []) {
  try {
    let value = null
    if (step.call === 'rerun') runInNewContext(input.script, sandbox)
    else if (step.call === 'capabilities') value = await sandbox.PublicKeyCredential.getClientCapabilities()
    else if (step.call === 'uvpaa')
      value = await sandbox.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    else value = await credentials[step.call](...(step.args ?? []))
    steps.push({ ok: true, value })
  } catch (error) {
    steps.push({ ok: false, name: error.name, message: error.message })
  }
}
process.stdout.write(
  JSON.stringify({
    steps,
    calls: calls.map((call) => call.name),
    info,
    publicKeyCredentialKeys: Object.keys(sandbox.PublicKeyCredential),
  }),
)
