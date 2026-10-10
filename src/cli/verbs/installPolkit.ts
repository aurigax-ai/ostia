import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { POLKIT_ACTIONS_DIR, POLKIT_POLICY_FILE } from '../../shared/permissions/scriptTokens'

export const INSTALL_POLKIT_USAGE = 'usage: sudo ostia install-polkit'

export interface InstallPolkitDeps {
  platform: NodeJS.Platform
  uid: number | undefined
  resources: string
  actionsDir?: string
  out: (line: string) => void
  err: (line: string) => void
}

export function cliResources(cliDir: string): string {
  return join(cliDir, '..', '..', '..')
}

export function runInstallPolkit(argv: readonly string[], deps: InstallPolkitDeps): number {
  if (argv.length > 0) {
    deps.err(INSTALL_POLKIT_USAGE)
    return argv[0] === '--help' || argv[0] === '-h' ? 0 : 2
  }
  if (deps.platform !== 'linux') {
    deps.err('ostia install-polkit: polkit is for Linux; macOS asks with Touch ID')
    return 1
  }
  if (deps.uid !== 0) {
    deps.err(
      `ostia install-polkit: needs root to write ${POLKIT_ACTIONS_DIR}; ${INSTALL_POLKIT_USAGE}`,
    )
    return 1
  }
  const source = join(deps.resources, 'polkit', POLKIT_POLICY_FILE)
  if (!existsSync(source)) {
    deps.err(`ostia install-polkit: ${source} is missing; reinstall Ostia`)
    return 1
  }
  const dir = deps.actionsDir ?? POLKIT_ACTIONS_DIR
  const dest = join(dir, POLKIT_POLICY_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(source, dest)
    chmodSync(dest, 0o644)
  } catch (err) {
    deps.err(`ostia install-polkit: could not write ${dest}: ${(err as Error).message}`)
    return 1
  }
  deps.out(
    `installed ${dest}; generating or regenerating a script token now asks for your password through polkit`,
  )
  return 0
}
