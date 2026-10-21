import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { REDACTION_PATTERN_MAX, REDACTION_PATTERNS_MAX } from '@shared/privacy/redaction'
import { ACTION_ICONS, ACTION_ID, ACTION_PLACES, ACTION_TITLE_MAX, ACTIONS_MAX } from './actions'

export const assistantSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chatHistory: {
      type: 'boolean',
      description: `Save assistant chat sessions on this computer (never synced), so a chat pane reopens its last session and you can search, rename, export or delete past ones. Terminal output you add as context is stored only as the text that was sent. Off keeps chats in memory until ${PRODUCT_DISPLAY_NAME} quits. Only you can change this; ostia settings set refuses it. Default: true.`,
    },
    mcpServers: {
      type: 'array',
      description:
        'MCP servers the assistant chat can call tools from. Each one runs a program from ' +
        'an argv (never a shell) or connects to an http(s) URL. Every tool call asks you ' +
        'in the chat first. Tokens go in Settings → Assistant (stored encrypted, ' +
        'never here). Only you can change this; ostia settings set refuses it.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$' },
          enabled: { type: 'boolean' },
          command: { type: 'array', items: { type: 'string' }, minItems: 1 },
          url: { type: 'string' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          secrets: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Names of environment variables (stdio) or headers (http) whose values are ' +
              'stored encrypted.',
          },
          disabledTools: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    skillFolders: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Absolute paths of skill folders (a folder with a SKILL.md, or a folder of them). ' +
        'The chat model sees each skill name and description and loads one when it needs ' +
        'it.',
    },
  },
}

export const agentHostSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providers: {
      type: 'array',
      description:
        'Models the Agent can use that you run yourself, through an OpenAI-compatible ' +
        'HTTP server (llama.cpp, vLLM, Ollama). Each entry is a key-less http(s) URL ' +
        'without credentials. Only you can change this; ostia settings set refuses it.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'baseUrl', 'models'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' },
          name: { type: 'string' },
          baseUrl: { type: 'string', description: 'For example http://127.0.0.1:8080/v1' },
          models: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  },
}

export const agentsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    autoResume: {
      type: 'boolean',
      description: `Resume an agent session that was running when ${PRODUCT_DISPLAY_NAME} quit, at its pane's first idle prompt once the pane is visible. Only you can change this; ostia settings set refuses it. Default: false.`,
    },
    trustWorkspaceFolders: {
      type: 'boolean',
      description: `When ${PRODUCT_DISPLAY_NAME} resumes or starts Claude in a workspace folder, mark that folder trusted in Claude's own config (~/.claude.json) so Claude does not ask. This trusts the folder for Claude outside ${PRODUCT_DISPLAY_NAME} too. Never your home folder, scratch or sandboxed workspaces. Turning it off does not remove trust already given. Only you can change this; ostia settings set refuses it. Default: false.`,
    },
    hooks: {
      type: 'object',
      additionalProperties: false,
      description: `${PRODUCT_DISPLAY_NAME}’s integration for each agent CLI in new terminals. Turn one off if it clashes with your own hooks; that agent then runs untouched and reports no attention state or resume token on its own. Only you can change this, in Settings; agents cannot.`,
      properties: {
        claude: {
          type: 'boolean',
          description: `Run claude with the ${PRODUCT_DISPLAY_NAME} plugin (CLI skill, resume token, attention hooks). Default: true.`,
        },
        codex: {
          type: 'boolean',
          description: `Run interactive codex sessions with ${PRODUCT_DISPLAY_NAME}’s hooks (resume token, attention state, CLI context). Default: true.`,
        },
      },
    },
    hibernation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          description:
            'Stop the shell of an idle, hidden agent terminal to save memory once more than ' +
            'maxLiveTerminals agents run. Only panes whose agent stored a resume token are ' +
            'hibernated; the scrollback is kept and Resume starts a fresh shell that runs ' +
            'the agent’s resume command. Default: false.',
        },
        idleSeconds: {
          type: 'number',
          minimum: 5,
          maximum: 86400,
          description:
            'Seconds without output or input before an agent terminal may hibernate. ' +
            'Default: 600.',
        },
        maxLiveTerminals: {
          type: 'number',
          minimum: 0,
          maximum: 64,
          description:
            'Agent terminals kept running before idle hidden ones hibernate. Default: 6.',
        },
      },
    },
  },
}

export const managerSchema = {
  type: 'object',
  additionalProperties: false,
  description: `The manager: one agent you start with \`ostia <agent>\` from a terminal outside ${PRODUCT_DISPLAY_NAME}. Only you can change this (Settings → Manager); agents cannot set it.`,
  properties: {
    agents: {
      type: 'object',
      description:
        'Presets for `ostia <name>` and for the workers the manager starts: a name mapped to ' +
        'the program and its arguments. claude and codex are built in; a preset with the ' +
        'same name replaces them.',
      additionalProperties: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    skills: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Absolute paths of skill folders (each with a SKILL.md) the manager gets besides ' +
        'its own guide. Workers never get these.',
    },
    allowInput: {
      type: 'boolean',
      description:
        "Let the manager type into other panes, for example to answer a worker's " +
        'permission prompt. Default: false.',
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxWorkers: { type: 'integer', minimum: 0, maximum: 64, description: 'Default: 8.' },
        spawnsPer10Min: {
          type: 'integer',
          minimum: 0,
          maximum: 200,
          description: 'Default: 20.',
        },
        busPerMinute: {
          type: 'integer',
          minimum: 0,
          maximum: 600,
          description: 'Default: 60.',
        },
      },
    },
  },
}

export const approvalsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['ask', 'allow'],
      description:
        'When an agent needs a capability it lacks: "ask" holds the request and asks you in ' +
        'the pane (Allow once / Allow for this pane / Deny); "allow" lets it through and ' +
        'records it in the permission inbox. Destructive actions always ask. Only you can ' +
        'change this; agents cannot, and it never syncs. Default: ask.',
    },
  },
}

export const capabilitiesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    grants: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'send-other-pane',
          'type-other-pane',
          'read-other-pane',
          'kill-pane',
          'all-workspaces',
          'shell',
          'destructive',
          'phone',
          'gateway',
          'browse',
          'settings-write',
          'credentials',
        ],
      },
      description: `Elevated capabilities pre-granted to every pane (pane-scoped defaults already cover the rest). Human-edited only; restart ${PRODUCT_DISPLAY_NAME} to apply.`,
    },
  },
}

export const trustedActionsSchema = {
  type: 'array',
  items: { type: 'string' },
  description: 'Actions you chose "Run and trust" for. Only you can change this; it never syncs.',
}

export const actionsSchema = {
  type: 'array',
  maxItems: ACTIONS_MAX,
  description:
    'Buttons and menu entries that run a palette command. Each also becomes a palette ' +
    'command "action.<id>" you can bind in keybindings. An action whose command needs a ' +
    'permission beyond the defaults asks before its first run.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title', 'command'],
    properties: {
      id: { type: 'string', pattern: ACTION_ID.source, description: 'Stable id, a-z 0-9 -.' },
      title: { type: 'string', maxLength: ACTION_TITLE_MAX, description: 'Label and tooltip.' },
      command: {
        type: 'string',
        description: 'A palette command id (see ostia commands), e.g. "pane.split".',
      },
      args: {
        type: 'object',
        description:
          'Arguments for the command. Strings may use {cwd} (the pane folder) and {file} ' +
          '(the file an editor pane shows).',
      },
      icon: {
        type: 'string',
        enum: [...ACTION_ICONS],
        description: 'Icon. Default: lightning.',
      },
      in: {
        type: 'array',
        items: { type: 'string', enum: [...ACTION_PLACES] },
        description:
          'Where it shows besides the palette: "paneHeader" (a button in each pane header), ' +
          '"tabMenu" (the pane tab right-click menu).',
      },
      paneKinds: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['terminal', 'editor', 'browser', 'git', 'diff', 'view'],
        },
        description: 'Only show it on these pane kinds. Default: all.',
      },
    },
  },
}

export const privacySchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Only you can change this (Settings → Privacy); agents cannot set it.',
  properties: {
    redaction: {
      type: 'object',
      additionalProperties: false,
      description: `Secret redaction. Text that leaves ${PRODUCT_DISPLAY_NAME} for an AI provider, or that it writes to disk (saved scrollback, the notification log, selection and pick reports), has detected secrets replaced with [redacted:<kind>]. The live terminal, the clipboard and your files are never changed.`,
      properties: {
        enabled: { type: 'boolean', description: 'Default: true.' },
        patterns: {
          type: 'array',
          maxItems: REDACTION_PATTERNS_MAX,
          items: { type: 'string', maxLength: REDACTION_PATTERN_MAX },
          description:
            'Your own patterns: regular expressions matched on one line at a time. No ' +
            'lookaround or backreferences, no repeated group that itself repeats or ' +
            'branches, at most one open-ended repeat (* + {n,}). A pattern that breaks a ' +
            'rule is ignored.',
        },
      },
    },
  },
}
