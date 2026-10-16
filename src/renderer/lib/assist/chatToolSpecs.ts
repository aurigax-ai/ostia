import type { ChatToolSpec } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { BuiltinChatTool } from '@shared/assist/chatTools'

const OBJECT = 'object'

export const BUILTIN_SPECS: Record<BuiltinChatTool, Omit<ChatToolSpec, 'name'>> = {
  read_file: {
    description:
      'Read a text file. Relative paths start at the workspace folder. Returns up to 2000 lines from offset (1-based), and the absolute path the edit tools also take.',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'integer', description: 'First line, 1-based' },
        limit: { type: 'integer', description: 'Number of lines' },
      },
      required: ['path'],
    },
  },
  list_directory: {
    description:
      'List a folder. Relative paths start at the workspace folder; empty means that folder.',
    inputSchema: {
      type: OBJECT,
      properties: { path: { type: 'string', description: 'Folder path' } },
    },
  },
  search_files: {
    description:
      'Search file names and contents (case-insensitive substring) under a folder, skipping .git and node_modules. Returns up to 100 matches.',
    inputSchema: {
      type: OBJECT,
      properties: {
        query: { type: 'string', description: 'Text to find' },
        path: { type: 'string', description: 'Folder to search, default the workspace folder' },
      },
      required: ['query'],
    },
  },
  terminal_context: {
    description:
      "The workspace terminal's current folder and its recent commands with exit codes (never their output).",
    inputSchema: { type: OBJECT, properties: {} },
  },
  git_status: {
    description: 'Branch, change counts and changed files of the repository the terminal is in.',
    inputSchema: { type: OBJECT, properties: {} },
  },
  load_skill: {
    description: 'Load the full instructions of a skill by name.',
    inputSchema: {
      type: OBJECT,
      properties: { name: { type: 'string', description: 'Skill name' } },
      required: ['name'],
    },
  },
  propose_command: {
    description:
      'Propose one shell command. The user sees it and chooses to insert it at the prompt, run it in a new terminal, or decline. You never see its output.',
    inputSchema: {
      type: OBJECT,
      properties: {
        command: { type: 'string', description: 'The command line' },
        explanation: { type: 'string', description: 'One short sentence on what it does' },
      },
      required: ['command'],
    },
  },
  edit_file: {
    description:
      'Change part of an existing text file by replacing exact text. Each old_text must match the file exactly (whitespace and indentation included) and exactly once, so include enough surrounding lines; edits apply in order. Prefer this over write_file for changes to an existing file. The user sees the diff; it is applied when they accept it, or right away when they chose Write mode.',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path, absolute or from the workspace folder' },
        edits: {
          type: 'array',
          description: 'Replacements, applied in order',
          items: {
            type: OBJECT,
            properties: {
              old_text: { type: 'string', description: 'Exact text to replace' },
              new_text: { type: 'string', description: 'Text to put in its place' },
              replace_all: {
                type: 'boolean',
                description: 'Replace every match instead of requiring one',
              },
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
      'Create a new text file, or replace a whole file, with the full content. Use edit_file to change part of an existing file. The user sees the diff; it is applied when they accept it, or right away when they chose Write mode.',
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'The complete new file content' },
      },
      required: ['path', 'content'],
    },
  },
  open_file: {
    description: "Open a file in the user's editor, optionally at a line. Asks the user first.",
    inputSchema: {
      type: OBJECT,
      properties: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'integer', description: 'Line to reveal, 1-based' },
      },
      required: ['path'],
    },
  },
  open_url: {
    description: "Open an http(s) URL in the workspace's browser pane. Asks the user first.",
    inputSchema: {
      type: OBJECT,
      properties: { url: { type: 'string', description: 'http or https URL' } },
      required: ['url'],
    },
  },
}
