import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const UI_TEXT_SIZES = ['ui-xs', 'ui-sm', 'ui-base', 'ui-emphasis', 'ui-lg']

const twMerge = extendTailwindMerge({
  extend: { theme: { text: UI_TEXT_SIZES } },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
