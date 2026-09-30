import { describe, expect, it } from 'vitest'
import { parseOsRelease, parseSwVers, windowsRelease } from './os'

const CACHYOS = `NAME="CachyOS Linux"
PRETTY_NAME="CachyOS"
ID=cachyos
BUILD_ID=rolling
ANSI_COLOR="38;2;23;147;209"
HOME_URL="https://cachyos.org/"
LOGO=cachyos
`

const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
`

const ROCKY = `NAME="Rocky Linux"
VERSION_ID='9.4'
ID="rocky"
ID_LIKE="rhel centos fedora"
# a comment
PRETTY_NAME="Rocky Linux 9.4 (Blue \\"Onyx\\")"
`

describe('parseOsRelease', () => {
  it('reads a rolling distro that has BUILD_ID instead of VERSION_ID', () => {
    expect(parseOsRelease(CACHYOS)).toEqual({
      id: 'cachyos',
      idLike: [],
      name: 'CachyOS',
      version: 'rolling',
    })
  })

  it('reads ID_LIKE into a list and prefers PRETTY_NAME', () => {
    expect(parseOsRelease(UBUNTU)).toEqual({
      id: 'ubuntu',
      idLike: ['debian'],
      name: 'Ubuntu 24.04.1 LTS',
      version: '24.04',
    })
  })

  it('handles single quotes, escaped double quotes, comments and several ID_LIKE entries', () => {
    expect(parseOsRelease(ROCKY)).toEqual({
      id: 'rocky',
      idLike: ['rhel', 'centos', 'fedora'],
      name: 'Rocky Linux 9.4 (Blue "Onyx")',
      version: '9.4',
    })
  })

  it('falls back to linux when the file has no ID', () => {
    expect(parseOsRelease('')).toEqual({ id: 'linux', idLike: [], name: 'linux', version: '' })
  })
})

describe('parseSwVers', () => {
  it('reads the product name and version macOS prints', () => {
    expect(
      parseSwVers('ProductName:\t\tmacOS\nProductVersion:\t\t14.5\nBuildVersion:\t\t23F79\n'),
    ).toEqual({ id: 'macos', idLike: [], name: 'macOS 14.5', version: '14.5' })
  })
})

describe('windowsRelease', () => {
  it('names Windows by its kernel release', () => {
    expect(windowsRelease('10.0.22631')).toEqual({
      id: 'windows',
      idLike: [],
      name: 'Windows 10.0.22631',
      version: '10.0.22631',
    })
  })
})
