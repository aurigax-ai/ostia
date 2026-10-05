import { mkdirSync } from 'node:fs'
import { app } from 'electron'
import { type UserDirsOutcome, describeOutcome, migrateUserDirs, userDirsPlan } from './userDirs'

function boot(): UserDirsOutcome {
  const overridden = app.commandLine.hasSwitch('user-data-dir')
  const plan = userDirsPlan(app.getPath('appData'), overridden)
  const outcome = migrateUserDirs(plan)
  if (plan.userData && outcome.userData?.status !== 'failed') {
    mkdirSync(plan.userData.to, { recursive: true })
    app.setPath('userData', plan.userData.to)
  }
  for (const line of describeOutcome(outcome)) console.error(line)
  return outcome
}

export const userDirsOutcome = boot()
