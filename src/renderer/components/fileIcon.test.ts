import {
  BracketsCurlyIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitForkIcon,
  KeyIcon,
  PackageIcon,
} from '@phosphor-icons/react'
import { describe, expect, it } from 'vitest'
import { fileIcon } from './fileIcon'

const BLUE = '#61afef'
const FOLDER = '#6f8db0'
const GREEN = '#89ca78'
const YELLOW = '#e5c07b'
const RED = '#ef596f'
const CYAN = '#56b6c2'
const ORANGE = '#d19a66'
const GREY = '#7f8696'

const f = (name: string, dir = false, open = false) => fileIcon({ name, dir }, open)

describe('fileIcon', () => {
  it('maps known special folders to their dedicated glyph', () => {
    expect(f('.git', true)).toEqual({ Icon: GitForkIcon, color: ORANGE })
    expect(f('node_modules', true)).toEqual({ Icon: FolderSimpleIcon, color: GREY })
    expect(f('src', true)).toEqual({ Icon: FolderSimpleIcon, color: BLUE })
  })

  it('falls back to a generic closed folder for unknown directories', () => {
    expect(f('whatever', true)).toEqual({ Icon: FolderIcon, color: FOLDER })
  })

  it('swaps the generic folder for an open one when open=true, same color', () => {
    const closed = f('whatever', true, false)
    const opened = f('whatever', true, true)
    expect(closed.Icon).toBe(FolderIcon)
    expect(opened.Icon).toBe(FolderOpenIcon)
    expect(opened.color).toBe(closed.color)
    expect(opened.color).toBe(FOLDER)
  })

  it('matches special folders case-insensitively', () => {
    expect(f('.GIT', true).Icon).toBe(GitForkIcon)
    expect(f('SRC', true).Icon).toBe(FolderSimpleIcon)
  })

  it('prefers an exact filename over its extension', () => {
    expect(f('package.json')).toEqual({ Icon: PackageIcon, color: RED })
  })

  it('resolves an extensionless name via the name map, case-insensitively', () => {
    expect(f('Dockerfile')).toEqual({ Icon: FileCodeIcon, color: CYAN })
    expect(f('README.md')).toEqual({ Icon: FileTextIcon, color: BLUE })
  })

  it('resolves plain files by their extension', () => {
    expect(f('index.ts')).toEqual({ Icon: FileCodeIcon, color: BLUE })
    expect(f('photo.PNG')).toEqual({ Icon: FileImageIcon, color: GREEN })
    expect(f('main.py')).toEqual({ Icon: FileCodeIcon, color: BLUE })
  })

  it('uses only the last segment of a multi-dot filename for the extension', () => {
    expect(f('x.js.ts')).toEqual({ Icon: FileCodeIcon, color: BLUE })
  })

  it('lets the name map win over the dotfile fallback', () => {
    expect(f('.env')).toEqual({ Icon: KeyIcon, color: YELLOW })
  })

  it('lets a known extension win over the dotfile fallback', () => {
    expect(f('.config.json')).toEqual({ Icon: BracketsCurlyIcon, color: YELLOW })
  })

  it('ignores open for a special folder, returning its dedicated glyph', () => {
    expect(f('.git', true, true)).toEqual({ Icon: GitForkIcon, color: ORANGE })
  })

  it('never consults the file name map for a directory (dir-gate in reverse)', () => {
    expect(f('package.json', true)).toEqual({ Icon: FolderIcon, color: FOLDER })
  })

  it('treats an unmapped dotfile as a config file', () => {
    expect(f('.zshrc')).toEqual({ Icon: GearSixIcon, color: GREY })
  })

  it('falls back to a plain file for unknown, non-dot names', () => {
    expect(f('Makefile')).toEqual({ Icon: FileIcon, color: GREY })
    expect(f('notes.xyz')).toEqual({ Icon: FileIcon, color: GREY })
  })

  it('does not treat a file named like a special folder as a folder', () => {
    expect(f('src', false)).toEqual({ Icon: FileIcon, color: GREY })
  })
})
