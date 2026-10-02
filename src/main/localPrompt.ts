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
