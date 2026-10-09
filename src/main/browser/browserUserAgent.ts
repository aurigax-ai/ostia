import { escapeRegExp } from 'es-toolkit'

export function browserUserAgent(defaultAgent: string, appName: string): string {
  const appToken = new RegExp(` ${escapeRegExp(appName)}/\\S+`, 'i')
  return defaultAgent
    .replace(/ Electron\/\S+/, '')
    .replace(appToken, '')
    .trim()
}
