import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join, posix, win32 } from 'node:path'
import type { BrowserPage } from '../../shared/common/externalLinks'
import { withoutGpuLaunchEnv } from '../platform/discreteGpu'

export interface BrowserLaunch {
  app: string
  command: string
  args: string[]
}

export interface BrowserHost {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  exists: (path: string) => boolean
}

const LINUX_BINARIES: Record<BrowserPage, { name: string; binary: string }[]> = {
  chrome: [
    { name: 'Google Chrome', binary: 'google-chrome-stable' },
    { name: 'Google Chrome', binary: 'google-chrome' },
    { name: 'Chromium', binary: 'chromium' },
    { name: 'Chromium', binary: 'chromium-browser' },
  ],
  edge: [
    { name: 'Microsoft Edge', binary: 'microsoft-edge-stable' },
    { name: 'Microsoft Edge', binary: 'microsoft-edge' },
  ],
  brave: [
    { name: 'Brave', binary: 'brave-browser' },
    { name: 'Brave', binary: 'brave' },
  ],
}

const MAC_APPS: Record<BrowserPage, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  brave: 'Brave Browser',
}

const WINDOWS_EXECUTABLES: Record<BrowserPage, { name: string; path: string }> = {
  chrome: {
    name: 'Google Chrome',
    path: win32.join('Google', 'Chrome', 'Application', 'chrome.exe'),
  },
  edge: {
    name: 'Microsoft Edge',
    path: win32.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
  },
  brave: {
    name: 'Brave',
    path: win32.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  },
}

export function browserLaunch(
  page: BrowserPage,
  url: string,
  host: BrowserHost,
): BrowserLaunch | null {
  if (host.platform === 'darwin') {
    const name = MAC_APPS[page]
    const bundle = [
      join('/Applications', `${name}.app`),
      join(host.home, 'Applications', `${name}.app`),
    ]
    return bundle.some(host.exists) ? { app: name, command: 'open', args: ['-a', name, url] } : null
  }
  if (host.platform === 'win32') {
    const { name, path } = WINDOWS_EXECUTABLES[page]
    const roots = [host.env.PROGRAMFILES, host.env['PROGRAMFILES(X86)'], host.env.LOCALAPPDATA]
    for (const root of roots) {
      const command = root ? win32.join(root, path) : ''
      if (command && host.exists(command)) return { app: name, command, args: [url] }
    }
    return null
  }
  const dirs = (host.env.PATH ?? '').split(delimiter).filter((dir) => posix.isAbsolute(dir))
  for (const { name, binary } of LINUX_BINARIES[page]) {
    for (const dir of dirs) {
      const command = posix.join(dir, binary)
      if (host.exists(command)) return { app: name, command, args: [url] }
    }
  }
  return null
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...withoutGpuLaunchEnv(env) }
  for (const key of Object.keys(out)) if (key.startsWith('OSTIA_')) delete out[key]
  return out
}

export function startBrowser(launch: BrowserLaunch, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: launchEnv(env),
    })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
