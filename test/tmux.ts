import { execFileSync } from 'node:child_process'
import { programPath } from '../src/main/systemRequirements'

export const tmuxPath = programPath('tmux')

export const skipWithoutTmux = tmuxPath === null && !process.env.CI

export function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    return !state.trim().startsWith('Z')
  } catch {
    return false
  }
}
