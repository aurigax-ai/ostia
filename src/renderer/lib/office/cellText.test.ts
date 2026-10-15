import { describe, expect, it } from 'vitest'
import { cellText, columnName } from './cellText'

const WORDS = { sheetTrue: 'TRUE', sheetFalse: 'FALSE' }

describe('cellText', () => {
  it('formats plain number formats in the locale', () => {
    expect(cellText({ n: 0.125, w: '12.50%', z: '0.00%' }, 'en', WORDS)).toBe('12.50%')
    expect(cellText({ n: 1234567.891, w: 'x', z: '#,##0.00' }, 'en', WORDS)).toBe('1,234,567.89')
    expect(cellText({ n: 1234567.891, w: 'x', z: '#,##0.00' }, 'de', WORDS)).toBe('1.234.567,89')
    expect(cellText({ n: 1234.5, w: 'x', z: '0' }, 'de', WORDS)).toBe('1235')
    expect(cellText({ n: 12345, w: 'x', z: '0.00E+00' }, 'en', WORDS)).toBe('1.23E4')
  })

  it('formats General numbers without grouping and with the locale separator', () => {
    expect(cellText(0.1 + 0.2, 'en', WORDS)).toBe('0.3')
    expect(cellText(1234.5, 'de', WORDS)).toBe('1234,5')
    expect(cellText(1.5e12, 'en', WORDS)).toBe('1.5E12')
  })

  it('keeps the file text for currency and custom formats', () => {
    expect(cellText({ n: 1234.5, w: '$1,234.50', z: '"$"#,##0.00' }, 'de', WORDS)).toBe('$1,234.50')
    expect(cellText({ n: 0.5, w: '1/2', z: '# ?/?' }, 'en', WORDS)).toBe('1/2')
  })

  it('formats dates and times in the locale', () => {
    const at = new Date(2023, 2, 15, 13, 5, 9).getTime()
    expect(cellText({ d: at, p: 'date' }, 'en-US', WORDS)).toBe('3/15/2023')
    expect(cellText({ d: at, p: 'date' }, 'zh-Hant', WORDS)).toBe('2023/3/15')
    expect(cellText({ d: at, p: 'time' }, 'en-US', WORDS)).toBe('1:05:09 PM')
    expect(cellText({ d: at, p: 'both' }, 'en-US', WORDS)).toBe('3/15/2023, 1:05:09 PM')
  })

  it('shows text, booleans, errors and empty cells', () => {
    expect(cellText('<b>x</b>', 'en', WORDS)).toBe('<b>x</b>')
    expect(cellText(true, 'en', { sheetTrue: '真', sheetFalse: '假' })).toBe('真')
    expect(cellText(false, 'en', WORDS)).toBe('FALSE')
    expect(cellText({ e: '#DIV/0!' }, 'en', WORDS)).toBe('#DIV/0!')
    expect(cellText(null, 'en', WORDS)).toBe('')
    expect(cellText(undefined, 'en', WORDS)).toBe('')
  })
})

describe('columnName', () => {
  it('names columns the way spreadsheets do', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 999].map(columnName)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'ALL',
    ])
  })
})
