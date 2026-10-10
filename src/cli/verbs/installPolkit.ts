import {
  constants,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { POLKIT_ACTIONS_DIR, POLKIT_POLICY_FILE } from '../../shared/permissions/scriptTokens'

export const INSTALL_POLKIT_USAGE = 'usage: sudo ostia install-polkit'

export const POLKIT_POLICY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>AurigaX</vendor>
  <vendor_url>https://github.com/aurigax-ai/ostia</vendor_url>
  <icon_name>ostia</icon_name>
  <action id="ai.aurigax.ostia.manage-script-tokens">
    <description>Generate or regenerate an Ostia script token</description>
    <description xml:lang="zh_TW">產生或重新產生 Ostia 腳本權杖</description>
    <message>Ostia wants to generate or regenerate a script token. Scripts outside Ostia can use it to control your terminals.</message>
    <message xml:lang="zh_TW">Ostia 要產生或重新產生腳本權杖。Ostia 以外的腳本能用它操作你的終端機。</message>
    <defaults>
      <allow_any>no</allow_any>
      <allow_inactive>no</allow_inactive>
      <allow_active>auth_self</allow_active>
    </defaults>
  </action>
</policyconfig>
`

export interface InstallPolkitDeps {
  platform: NodeJS.Platform
  uid: number | undefined
  actionsDir?: string
  out: (line: string) => void
  err: (line: string) => void
}

function writeNoFollow(dest: string, content: string): void {
  const fd = openSync(
    dest,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  )
  try {
    if (!lstatSync(dest).isFile()) throw new Error('not a regular file')
    fchmodSync(fd, 0o644)
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
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
  const dir = deps.actionsDir ?? POLKIT_ACTIONS_DIR
  const dest = join(dir, POLKIT_POLICY_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symbolic link`)
    writeNoFollow(dest, POLKIT_POLICY)
  } catch (err) {
    deps.err(`ostia install-polkit: refused to write ${dest}: ${(err as Error).message}`)
    return 1
  }
  deps.out(
    `installed ${dest}; generating or regenerating a script token now asks for your password through polkit`,
  )
  return 0
}
