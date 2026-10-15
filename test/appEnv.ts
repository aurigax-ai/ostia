import { isAppEnvName } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'

for (const name of Object.keys(process.env)) {
  if (isAppEnvName(name)) delete process.env[name]
}
