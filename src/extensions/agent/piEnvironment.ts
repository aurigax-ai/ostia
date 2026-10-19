const PI_ENVIRONMENT: Readonly<Record<string, string>> = {
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
  PI_SKIP_VERSION_CHECK: '1',
}

export function applyPiEnvironment(): void {
  Object.assign(process.env, PI_ENVIRONMENT)
  process.umask(0o077)
}
