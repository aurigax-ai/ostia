import { readEnv } from './appEnv'
import { PRODUCT_NAME } from './product'

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
