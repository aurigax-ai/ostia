import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'

export function portalSocketPath(
  packaged: boolean,
  env: Record<string, string | undefined>,
  fallbackDir: string,
): string {
  const override = readEnv('PORTAL_SOCKET', env)
  if (override) return override
  const name = packaged ? PRODUCT_NAME : `${PRODUCT_NAME}-dev`
  return `${env.XDG_RUNTIME_DIR || fallbackDir}/${name}-portal.sock`
}

export const MIRROR_DETACH_KEY = '\x1c'

export function portalSupported(platform: NodeJS.Platform): boolean {
  return platform === 'linux'
}
