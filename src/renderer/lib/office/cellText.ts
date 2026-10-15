import { DATE_ONLY, DATE_TIME, TIME_ONLY, formatDate, formatNumber } from '@/lib/app/localeFormat'
import type { DateParts, SheetCell } from './sheetModel'

const GENERAL: Intl.NumberFormatOptions = { useGrouping: false, maximumFractionDigits: 10 }
const GENERAL_SCIENTIFIC: Intl.NumberFormatOptions = {
  notation: 'scientific',
  maximumFractionDigits: 5,
}
const PLAIN_FORMAT = /^(#,##)?0(?:\.(0+))?(%|E\+0+)?$/i

const DATE_OPTIONS: Record<DateParts, Intl.DateTimeFormatOptions> = {
  date: DATE_ONLY,
  time: TIME_ONLY,
  both: DATE_TIME,
}

const plainFormats = new Map<string, Intl.NumberFormatOptions | null>()

function plainOptions(format: string): Intl.NumberFormatOptions | null {
  const known = plainFormats.get(format)
  if (known !== undefined) return known
  const match = PLAIN_FORMAT.exec(format)
  const digits = match?.[2]?.length ?? 0
  const suffix = match?.[3]?.toUpperCase()
  const options: Intl.NumberFormatOptions | null = match
    ? {
        useGrouping: Boolean(match[1]),
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        ...(suffix === '%' ? { style: 'percent' } : {}),
        ...(suffix?.startsWith('E') ? { notation: 'scientific' } : {}),
      }
    : null
  plainFormats.set(format, options)
  return options
}

function generalText(value: number, locale: string): string {
  const size = Math.abs(value)
  const scientific = size >= 1e11 || (size > 0 && size < 1e-9)
  return formatNumber(value, locale, scientific ? GENERAL_SCIENTIFIC : GENERAL)
}

export interface BooleanWords {
  sheetTrue: string
  sheetFalse: string
}

export function cellText(cell: SheetCell | undefined, locale: string, words: BooleanWords): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number') return generalText(cell, locale)
  if (typeof cell === 'boolean') return cell ? words.sheetTrue : words.sheetFalse
  if ('e' in cell) return cell.e
  if ('d' in cell) return formatDate(cell.d, locale, DATE_OPTIONS[cell.p])
  const options = plainOptions(cell.z)
  return options ? formatNumber(cell.n, locale, options) : cell.w
}

export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}
