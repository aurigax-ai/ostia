import { privateRunDir } from '../platform/privateTmp'

export function shellStateDir(): string {
  return privateRunDir('shell-state')
}
