import { isAppEnvName } from '../src/shared/appEnv'

for (const name of Object.keys(process.env)) {
  if (isAppEnvName(name)) delete process.env[name]
}
