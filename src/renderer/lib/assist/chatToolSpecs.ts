import type { ChatToolSpec } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { BuiltinChatTool, SkillSummary } from '@shared/assist/chatTools'

const OBJECT = 'object'
const SKILLS_LISTED_MAX = 32

export const BUILTIN_SPECS: Record<BuiltinChatTool, Omit<ChatToolSpec, 'name'>> = {
  read_file: {
    description:
      'Read a text file, relative to the workspace folder. Returns up to 2000 lines and the absolute path the edit tools take.',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: 'First line, 1-based' },
        limit: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  list_directory: {
    description: 'List a folder, relative to the workspace folder (empty for that folder).',
    inputSchema: { type: OBJECT, properties: { path: { type: 'string' } } },
  },
  search_files: {
    description:
      'Find a case-insensitive substring in file names and contents under a folder (default the workspace folder), skipping .git and node_modules. Up to 100 matches.',
    inputSchema: {
      type: OBJECT,
      properties: { query: { type: 'string' }, path: { type: 'string' } },
      required: ['query'],
    },
  },
  terminal_context: {
    description:
      "The workspace terminal's folder and recent commands with exit codes, never their output.",
    inputSchema: { type: OBJECT, properties: {} },
  },
  git_status: {
    description: "Branch, change counts and changed files of the terminal's repository.",
    inputSchema: { type: OBJECT, properties: {} },
  },
  load_skill: {
    description: 'Load the instructions of a skill by name.',
    inputSchema: {
      type: OBJECT,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  propose_command: {
    description:
      'Propose one shell command. The user inserts it at the prompt, runs it in a new terminal or declines; you never see its output.',
    inputSchema: {
      type: OBJECT,
      properties: {
        command: { type: 'string' },
        explanation: { type: 'string', description: 'One short sentence on what it does' },
      },
      required: ['command'],
    },
  },
  edit_file: {
    description:
      'Replace exact text in an existing file; prefer it to write_file. Each old_text must match exactly once (unless replace_all), whitespace included, so add surrounding lines. Edits apply in order. The user reviews the diff.',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: OBJECT,
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
              replace_all: { type: 'boolean', description: 'Replace every match' },
            },
            required: ['old_text', 'new_text'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  write_file: {
    description:
      'Create a text file or replace a whole one; use edit_file to change part of a file. The user reviews the diff.',
    inputSchema: {
      type: OBJECT,
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  open_file: {
    description: "Open a file in the user's editor, optionally at a line.",
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string' },
        line: { type: 'integer', description: '1-based' },
      },
      required: ['path'],
    },
  },
  open_url: {
    description: "Open an http(s) URL in the workspace's browser pane.",
    inputSchema: {
      type: OBJECT,
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
}

export function skillsDescription(skills: SkillSummary[]): string {
  const names = skills.slice(0, SKILLS_LISTED_MAX).map((s) => `- ${s.name}`)
  const more = skills.length - names.length
  if (more > 0) names.push(`- and ${more} more`)
  return `${BUILTIN_SPECS.load_skill.description} Skills:\n${names.join('\n')}`
}
