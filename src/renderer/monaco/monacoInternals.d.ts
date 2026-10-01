declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/language/json/jsonMode.js' {
  export function setupMode(defaults: unknown): { dispose(): void }
}

interface MonacoLanguageDefaults {
  readonly modeConfiguration: Record<string, boolean | undefined>
  setModeConfiguration(configuration: Record<string, boolean | undefined>): void
}

declare module 'monaco-editor/esm/vs/language/json/monaco.contribution.js' {
  export const jsonDefaults: MonacoLanguageDefaults
}

declare module 'monaco-editor/esm/vs/language/css/monaco.contribution.js' {
  export const cssDefaults: MonacoLanguageDefaults
  export const scssDefaults: MonacoLanguageDefaults
  export const lessDefaults: MonacoLanguageDefaults
}

declare module 'monaco-editor/esm/vs/language/html/monaco.contribution.js' {
  export const htmlDefaults: MonacoLanguageDefaults
  export const handlebarDefaults: MonacoLanguageDefaults
  export const razorDefaults: MonacoLanguageDefaults
}
