import type { ExtensionResult, ExtensionSettingValues } from '../contract/extensions'

export function ok(text?: string, data?: unknown): ExtensionResult {
  const result: ExtensionResult = { ok: true }
  if (text !== undefined) result.text = text
  if (data !== undefined) result.data = data
  return result
}

export function failure(error: string, message?: string): ExtensionResult {
  return message ? { ok: false, error, message } : { ok: false, error }
}

export function numberSetting(
  values: ExtensionSettingValues,
  key: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const value = values[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, value))
}

export function booleanSetting(
  values: ExtensionSettingValues,
  key: string,
  fallback: boolean,
): boolean {
  const value = values[key]
  return typeof value === 'boolean' ? value : fallback
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
