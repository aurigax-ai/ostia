import { join } from 'node:path'

export function wireDataDir(
  dataHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin'
    ? join(dataHome, 'home', 'Library', 'Application Support', 'wire')
    : join(dataHome, 'state', 'wire')
}
