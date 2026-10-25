import { app } from 'electron'
import { launchThroughSystemd } from './systemdLaunch'

export function launchSelf(env: NodeJS.ProcessEnv): boolean {
  return launchThroughSystemd({
    exe: process.env.APPIMAGE ?? process.execPath,
    args: process.argv.slice(1),
    env,
    waitForPid: process.pid,
  })
}

export function relaunchApp(): void {
  if (!launchSelf(process.env)) app.relaunch()
}
