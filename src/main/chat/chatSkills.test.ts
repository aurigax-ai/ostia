import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_FILE_MAX } from '../../shared/assist/chatTools'
import { listSkills, loadSkill, parseSkillText } from './chatSkills'

let base: string

function skill(dir: string, name: string, description: string, body = 'Do the thing.'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  )
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-skills-'))
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('parseSkillText', () => {
  it('needs front matter with a valid name and a description', () => {
    expect(parseSkillText('---\nname: a\ndescription: b\n---\nbody', 'x')).toEqual({
      name: 'a',
      description: 'b',
      body: 'body',
    })
    expect(parseSkillText('---\ndescription: b\n---\n', 'folder')?.name).toBe('folder')
    expect(parseSkillText('no front matter', 'x')).toBeNull()
    expect(parseSkillText('---\nname: a\n---\n', 'x')).toBeNull()
    expect(parseSkillText('---\nname: "../evil"\ndescription: b\n---\n', 'x')).toBeNull()
    expect(parseSkillText('---\nname: a\ndescription: &d b\nalso: *d\n---\n', 'x')).toBeNull()
  })
})

describe('listSkills and loadSkill', () => {
  it('reads a folder of skills and a single skill folder', () => {
    const folder = join(base, 'skills')
    skill(join(folder, 'deploy'), 'deploy', 'Ship the app')
    skill(join(folder, 'review'), 'review', 'Review a diff')
    const single = join(base, 'single')
    skill(single, 'single', 'One skill')
    expect(listSkills([folder, single]).map((s) => s.name)).toEqual(['deploy', 'review', 'single'])
    expect(loadSkill([folder], 'review')).toMatchObject({ ok: true, body: 'Do the thing.\n' })
    expect(loadSkill([folder], 'nope')).toEqual({ ok: false, error: 'unknown-skill' })
    expect(loadSkill([folder], '../x')).toEqual({ ok: false, error: 'invalid' })
  })

  it('skips symlinked skill folders and files, and oversized files', () => {
    const folder = join(base, 'skills')
    const outside = join(base, 'outside')
    skill(outside, 'linked', 'Came through a link')
    mkdirSync(folder, { recursive: true })
    symlinkSync(outside, join(folder, 'linked'))
    mkdirSync(join(folder, 'filelink'))
    symlinkSync(join(outside, 'SKILL.md'), join(folder, 'filelink', 'SKILL.md'))
    skill(join(folder, 'big'), 'big', 'Too big', 'x'.repeat(SKILL_FILE_MAX))
    skill(join(folder, 'ok'), 'ok', 'Fine')
    expect(listSkills([folder]).map((s) => s.name)).toEqual(['ok'])
    expect(loadSkill([folder], 'linked')).toEqual({ ok: false, error: 'unknown-skill' })
    const linkedFolder = join(base, 'linked-root')
    symlinkSync(folder, linkedFolder)
    expect(listSkills([linkedFolder])).toEqual([])
  })
})
