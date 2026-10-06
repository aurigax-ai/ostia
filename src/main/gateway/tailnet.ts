import { posix, win32 } from 'node:path'

export function tsnetHelperPath(appPath: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  const binary = platform === 'win32' ? 'ostia-tsnet.exe' : 'ostia-tsnet'
  return path.join(appPath.replace(/\.asar$/, '.asar.unpacked'), 'out', 'tsnet', binary)
}
