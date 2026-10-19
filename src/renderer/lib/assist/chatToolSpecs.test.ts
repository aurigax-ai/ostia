import { BUILTIN_TOOL_ACCESS } from '@shared/assist/chatTools'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SPECS, skillsDescription } from './chatToolSpecs'

function skills(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `skill-${i}`,
    description: `What skill ${i} is for, in a long sentence the model never needs to see.`,
    path: `/home/u/.claude/skills/skill-${i}/SKILL.md`,
  }))
}

function declaration(name: string, description: string, inputSchema: unknown): string {
  return JSON.stringify({ name, description, parameters: inputSchema })
}

describe('load_skill description', () => {
  it('lists each skill by name on its own line, never its description', () => {
    const text = skillsDescription(skills(3))
    expect(text.split('\n').slice(1)).toEqual(['- skill-0', '- skill-1', '- skill-2'])
    expect(text).not.toContain('What skill')
  })

  it('lists at most 32 names and counts the rest', () => {
    const lines = skillsDescription(skills(40)).split('\n').slice(1)
    expect(lines).toHaveLength(33)
    expect(lines[31]).toBe('- skill-31')
    expect(lines[32]).toBe('- and 8 more')
  })

  it('stays short for the most skills a human can have', () => {
    expect(skillsDescription(skills(128)).length).toBeLessThan(600)
  })
})

describe('built-in tool declarations', () => {
  it('cost under 3,100 characters together, edit_file under 650', () => {
    const sizes = Object.keys(BUILTIN_TOOL_ACCESS).map((name) => {
      const spec = BUILTIN_SPECS[name as keyof typeof BUILTIN_SPECS]
      const description = name === 'load_skill' ? skillsDescription(skills(1)) : spec.description
      return [name, declaration(name, description, spec.inputSchema).length] as const
    })
    const total = sizes.reduce((sum, [, size]) => sum + size, 0)
    expect(total).toBeLessThan(3100)
    expect(Object.fromEntries(sizes).edit_file).toBeLessThan(650)
  })
})
