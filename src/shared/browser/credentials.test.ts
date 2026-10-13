import { describe, expect, it } from 'vitest'
import { normalizeOrigin, parseCsv, passwordRowsFromCsv } from './credentials'

describe('normalizeOrigin', () => {
  it('keeps only the scheme, host and port of an http(s) URL', () => {
    expect(normalizeOrigin('https://github.com/login?x=1')).toBe('https://github.com')
    expect(normalizeOrigin('http://localhost:3000/a')).toBe('http://localhost:3000')
  })

  it('refuses other schemes and junk', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeOrigin('github.com')).toBeNull()
  })
})

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and newlines', () => {
    expect(parseCsv('a,"b,c","say ""hi""","two\nlines"\r\nx,y,,\n')).toEqual([
      ['a', 'b,c', 'say "hi"', 'two\nlines'],
      ['x', 'y', '', ''],
    ])
  })
})

describe('passwordRowsFromCsv', () => {
  it('reads a Chrome export', () => {
    expect(
      passwordRowsFromCsv('name,url,username,password,note\ngh,https://github.com/,me,s3cret,\n'),
    ).toEqual([{ origin: 'https://github.com/', username: 'me', password: 's3cret' }])
  })

  it('reads a Bitwarden export by its column names', () => {
    const csv =
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
      ',,login,gh,,,0,https://github.com,me,pw,\n'
    expect(passwordRowsFromCsv(csv)).toEqual([
      { origin: 'https://github.com', username: 'me', password: 'pw' },
    ])
  })

  it('returns null when there is no url or password column', () => {
    expect(passwordRowsFromCsv('name,note\na,b\n')).toBeNull()
  })
})
