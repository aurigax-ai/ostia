import {
  File,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileText,
  Folder,
  FolderArchive,
  FolderCode,
  FolderGit2,
  FolderOpen,
  Package,
} from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { fileIcon } from './fileIcon'

// One Dark Vivid accents the module tints with (kept private there, mirrored here).
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
    expect(f('.git', true)).toEqual({ Icon: FolderGit2, color: ORANGE })
    expect(f('node_modules', true)).toEqual({ Icon: FolderArchive, color: GREY })
    expect(f('src', true)).toEqual({ Icon: FolderCode, color: BLUE })
  })

  it('falls back to a generic closed folder for unknown directories', () => {
    expect(f('whatever', true)).toEqual({ Icon: Folder, color: FOLDER })
  })

  it('swaps the generic folder for an open one when open=true, same color', () => {
    const closed = f('whatever', true, false)
    const opened = f('whatever', true, true)
    expect(closed.Icon).toBe(Folder)
    expect(opened.Icon).toBe(FolderOpen)
    expect(opened.color).toBe(closed.color)
    expect(opened.color).toBe(FOLDER)
  })

  it('matches special folders case-insensitively', () => {
    expect(f('.GIT', true).Icon).toBe(FolderGit2)
    expect(f('SRC', true).Icon).toBe(FolderCode)
  })

  it('prefers an exact filename over its extension', () => {
    // package.json would resolve to FileJson (yellow) by extension, but the name map wins (Package/red).
    expect(f('package.json')).toEqual({ Icon: Package, color: RED })
  })

  it('resolves an extensionless name via the name map, case-insensitively', () => {
    // Dockerfile has no extension; it only resolves through the (lowercased) name map.
    expect(f('Dockerfile')).toEqual({ Icon: FileCode, color: CYAN })
    // README.md resolves via the name map too (lowercased 'readme.md').
    expect(f('README.md')).toEqual({ Icon: FileText, color: BLUE })
  })

  it('resolves plain files by their extension', () => {
    expect(f('index.ts')).toEqual({ Icon: FileCode, color: BLUE })
    expect(f('photo.PNG')).toEqual({ Icon: FileImage, color: GREEN })
    expect(f('main.py')).toEqual({ Icon: FileCode, color: BLUE })
  })

  it('uses only the last segment of a multi-dot filename for the extension', () => {
    // 'x.js.ts' → 'ts' (FileCode/blue), NOT 'js' (which would be FileCode/yellow).
    // The color is what distinguishes: last segment wins.
    expect(f('x.js.ts')).toEqual({ Icon: FileCode, color: BLUE })
  })

  it('lets the name map win over the dotfile fallback', () => {
    // '.env' starts with a dot, but the NAME entry (FileKey) wins over the FileCog fallback.
    expect(f('.env')).toEqual({ Icon: FileKey, color: YELLOW })
  })

  it('lets a known extension win over the dotfile fallback', () => {
    // '.config.json' → extension 'json' resolves via EXT (FileJson), not startsWith('.') → FileCog.
    expect(f('.config.json')).toEqual({ Icon: FileJson, color: YELLOW })
  })

  it('ignores open for a special folder, returning its dedicated glyph', () => {
    // The FOLDER map returns before the `open ? FolderOpen : Folder` branch.
    expect(f('.git', true, true)).toEqual({ Icon: FolderGit2, color: ORANGE })
  })

  it('never consults the file name map for a directory (dir-gate in reverse)', () => {
    // A directory named 'package.json' is still a generic folder, not the Package glyph.
    expect(f('package.json', true)).toEqual({ Icon: Folder, color: FOLDER })
  })

  it('treats an unmapped dotfile as a config file', () => {
    // '.zshrc' → extension 'zshrc' is unmapped, but the name starts with a dot.
    expect(f('.zshrc')).toEqual({ Icon: FileCog, color: GREY })
  })

  it('falls back to a plain file for unknown, non-dot names', () => {
    expect(f('Makefile')).toEqual({ Icon: File, color: GREY })
    expect(f('notes.xyz')).toEqual({ Icon: File, color: GREY })
  })

  it('does not treat a file named like a special folder as a folder', () => {
    // Same name as the 'src' folder, but dir=false must go through the file branch.
    expect(f('src', false)).toEqual({ Icon: File, color: GREY })
  })
})
