import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { KEPT_SHELLS_DIR } from '../../shared/terminal/keepShells'

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function keptShellsDir(userData: string): string {
  return join(userData, KEPT_SHELLS_DIR)
}

export function keptShellsName(userData: string): string {
  return shortHash(userData)
}

export function keptHostChannel(userData: string, workspaceId: string): string {
  return join(
    keptShellsDir(userData),
    `host-${shortHash(`${keptShellsName(userData)}\0${workspaceId}`)}.sock`,
  )
}
