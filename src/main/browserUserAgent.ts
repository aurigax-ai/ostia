const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function browserUserAgent(defaultAgent: string, appName: string): string {
  const appToken = new RegExp(` ${escape(appName)}/\\S+`, 'i')
  return defaultAgent
    .replace(/ Electron\/\S+/, '')
    .replace(appToken, '')
    .trim()
}
