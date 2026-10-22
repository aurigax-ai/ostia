import { app } from 'electron'
import { launchThroughSystemd } from './systemdLaunch'

export function relaunchApp(): void {
  const launched = launchThroughSystemd({
    exe: process.env.APPIMAGE ?? process.execPath,
    args: process.argv.slice(1),
    env: process.env,
    waitForPid: process.pid,
  })
  if (!launched) app.relaunch()
}
