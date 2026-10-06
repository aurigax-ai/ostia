import { basename } from 'node:path'

export interface PromptOwner {
  foreground: string
  shell: string
  sandboxed: boolean
}

const programName = (value: string): string => basename(value).replace(/^-/, '')

export function atLocalPrompt({ foreground, shell, sandboxed }: PromptOwner): boolean {
  if (sandboxed || shell === '' || foreground === '') return true
  return programName(foreground) === programName(shell)
}

export function busyProgram(owner: PromptOwner): string | null {
  return atLocalPrompt(owner) ? null : programName(owner.foreground)
}
