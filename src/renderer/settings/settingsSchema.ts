import {
  CORE_CHIP_IDS,
  MAX_PROMPT_CHIPS,
  PROMPT_SEPARATORS,
  PROMPT_STYLES,
} from '../../shared/promptSettings'
import { MATCH_PINE_THEME } from '../../shared/themeChoice'
import { DEFAULT_CHORDS, bindableIds } from '../lib/chords'
import { BUILTIN_COLOR_SCHEMES } from '../plugins/colorSchemes'
import { ACTIONS_MAX, ACTION_ICONS, ACTION_ID, ACTION_PLACES, ACTION_TITLE_MAX } from './actions'
import {
  EXCLUDE_MAX,
  FILE_SORT_BYS,
  FILE_SORT_ORDERS,
  NESTING_MAX,
  PATTERN_MAX_LENGTH,
} from './fileTreeSettings'

const font = (title: string) => ({
  type: 'object',
  title,
  additionalProperties: false,
  properties: {
    family: { type: 'string', description: 'Font family name.' },
    size: { type: 'number', minimum: 8, maximum: 32, description: 'Font size in px.' },
    weight: {
      type: 'number',
      enum: [300, 400, 450, 500, 600, 700],
      description:
        'Body text weight. In the UI, emphasis and headings step up from it (+100, +200).',
    },
  },
})

const schemeChoice = (surface: string) => ({
  type: 'string',
  examples: [MATCH_PINE_THEME, ...BUILTIN_COLOR_SCHEMES.map((s) => s.id)],
  description: [
    `Color scheme for the ${surface}.`,
    `"${MATCH_PINE_THEME}" uses the scheme of appearance.theme (following its light/dark switch);`,
    'a scheme id such as catppuccin-mocha keeps that scheme whatever the app theme is.',
    `An unknown id falls back to the app theme's scheme. Default: ${MATCH_PINE_THEME}.`,
  ].join(' '),
})

const CHORD_VALUE = {
  type: ['string', 'null'],
  description:
    'A chord like "Ctrl+Shift+K", "Cmd+Alt+P" or "Mod+Shift+K" (Mod is Cmd on macOS, Ctrl ' +
    'elsewhere), or null to unbind. Chords the shell needs are ignored: plain Ctrl+letter, ' +
    'plain or Ctrl arrows, Escape, Tab and keys without Ctrl/Cmd.',
}

export function keybindingsSchema(ids: readonly string[]) {
  return {
    type: 'object',
    description:
      'Keyboard shortcuts: command id → chord, or null to unbind. Unlisted commands keep ' +
      'their default. Edit them in Settings → Keyboard.',
    properties: Object.fromEntries(ids.map((id) => [id, CHORD_VALUE])),
    additionalProperties: CHORD_VALUE,
  }
}

export const SETTINGS_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Pine Settings',
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: {
      type: 'string',
      enum: ['en', 'zh-Hant'],
      description: 'Interface language.',
    },
    appearance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: {
          type: 'string',
          description:
            'Theme id (built-in: adeberry, one-dark-vivid, instrument-night, dracula, oxocarbon, pine-light; ' +
            'or a plugin theme). Default: adeberry.',
        },
        followSystem: {
          type: 'boolean',
          description:
            'Switch between lightTheme and darkTheme when the operating system switches. When ' +
            'off, "theme" is used. Default: false.',
        },
        lightTheme: {
          type: 'string',
          description:
            'Theme id used when the OS is light and followSystem is on. Default: pine-light.',
        },
        darkTheme: {
          type: 'string',
          description:
            'Theme id used when the OS is dark and followSystem is on. Default: adeberry.',
        },
        accent: {
          type: 'string',
          pattern: '^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}))?$',
          description:
            'Hex color (#rgb or #rrggbb) that replaces the theme’s brand color. Empty uses the ' +
            'theme’s own. Default: empty.',
        },
        zoom: {
          type: 'integer',
          minimum: 80,
          maximum: 150,
          description: 'Interface zoom in percent. Default: 100.',
        },
        motion: {
          type: 'string',
          enum: ['system', 'reduced', 'full'],
          description:
            'Interface animation. "system" follows the OS reduce-motion preference, "reduced" ' +
            'turns movement off (state stays visible), "full" animates regardless of the OS. ' +
            'Default: system.',
        },
        windowTitle: {
          type: 'string',
          maxLength: 120,
          description:
            'Window title shown by the OS (taskbar, Alt+Tab). Placeholders: {workspace}, ' +
            '{pane}, {cwd}, {product}. Default: "{workspace} · {product}".',
        },
        ui: font('UI font'),
        terminal: {
          ...font('Terminal font'),
          properties: {
            ...font('Terminal font').properties,
            lineHeight: {
              type: 'number',
              minimum: 1,
              maximum: 2,
              description: 'Terminal row height as a multiple of the font size. Default: 1.15.',
            },
          },
        },
        editor: font('Editor font'),
      },
    },
    behavior: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cursorStyle: {
          type: 'string',
          enum: ['block', 'underline', 'bar'],
          description: 'Terminal cursor shape.',
        },
        cursorBlink: { type: 'boolean', description: 'Blink the terminal cursor.' },
        inputMode: {
          type: 'string',
          enum: ['terminal', 'editor'],
          description:
            'How you type commands. "terminal" types straight into the shell. "editor" docks ' +
            'an input editor under the command blocks while the shell waits at a prompt ' +
            '(multi-line, history on Up, path completion on Tab); running programs still get ' +
            'your keys directly. Shells without integration always use "terminal". ' +
            'Default: terminal.',
        },
        inputEditorVim: {
          type: 'boolean',
          description:
            'Edit commands in the input editor with vim keys. Esc switches to normal mode ' +
            '(h j k l w b e 0 $ x dd dw cw u, with counts); i a A I o O return to insert mode. ' +
            'Enter runs the command from either mode. Default: false.',
        },
        copyOnSelect: {
          type: 'boolean',
          description: 'Copy selected terminal text to the clipboard as soon as it is selected.',
        },
        gpuAcceleration: {
          type: 'boolean',
          description:
            'Draw terminals on the GPU (WebGL). Block and box-drawing characters then fill ' +
            'their cells exactly. Falls back to the DOM renderer when WebGL is unavailable. ' +
            'Applies to new terminals.',
        },
        restoreWorkspace: {
          type: 'boolean',
          description:
            'Reopen the previous run’s workspaces, panes and terminal scrollback at launch. ' +
            'Shells are always respawned fresh; this restores the workspace’s shape and ' +
            'history, not live processes. Turning it off erases what is already stored.',
        },
        checkForUpdates: {
          type: 'boolean',
          description:
            'Ask GitHub once after launch and then once a day whether a newer release exists, ' +
            'and show a notice when one does. Nothing is downloaded or installed. Only you can ' +
            'change this, in Settings → About. Default: true.',
        },
        externalEditor: {
          type: 'string',
          description:
            'Command for "Open in External Editor". "auto" picks the first of code, cursor, zed ' +
            'on PATH; empty turns it off. Placeholders: {file}, {line}, {column}, e.g. ' +
            '"code -g {file}:{line}:{column}". Runs the program directly, never through a shell.',
        },
      },
    },
    files: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exclude: {
          type: 'array',
          maxItems: EXCLUDE_MAX,
          items: { type: 'string', maxLength: PATTERN_MAX_LENGTH },
          description:
            "Glob patterns of files and folders the Files explorer hides, like VS Code's " +
            'files.exclude. A pattern matches the path relative to the folder the explorer ' +
            'shows or the absolute path: "**/node_modules" hides every node_modules, ' +
            '"**/.*" hides dotfiles. "Hide in tree" adds the item\'s absolute path. ' +
            'Default: .git, .hg, .svn, .DS_Store and Thumbs.db anywhere.',
        },
        showExcluded: {
          type: 'boolean',
          description:
            'Show excluded files anyway, dimmed (the eye button in the Files header). ' +
            'Default: false.',
        },
        compactFolders: {
          type: 'boolean',
          description:
            'Show a chain of folders that each hold only one folder as one row, like ' +
            '"src/main/java". Default: true.',
        },
        nesting: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
              description:
                "Group related files under a parent file, like VS Code's file nesting. " +
                'Default: true.',
            },
            patterns: {
              type: 'object',
              maxProperties: NESTING_MAX,
              additionalProperties: { type: 'string', maxLength: PATTERN_MAX_LENGTH },
              description:
                'Parent file pattern → comma-separated child patterns (VS Code syntax). A ' +
                'parent may hold one "*"; children may use "*" and "${capture}" (the text the ' +
                'parent\'s "*" matched), e.g. "*.ts": "${capture}.test.ts, ${capture}.d.ts" or ' +
                '"package.json": "pnpm-lock.yaml". Replaces the defaults when set.',
            },
          },
        },
        sortOrder: {
          type: 'string',
          enum: [...FILE_SORT_ORDERS],
          description:
            'foldersFirst lists folders above files; mixed interleaves them. Default: foldersFirst.',
        },
        sortBy: {
          type: 'string',
          enum: [...FILE_SORT_BYS],
          description: 'Sort by name, or by file type (extension) then name. Default: name.',
        },
        iconTheme: {
          type: 'string',
          description:
            'File icon theme: "pine" (built-in) or the id of a VS Code icon theme an enabled ' +
            'extension contributes (contributes.iconThemes). Default: pine.',
        },
      },
    },
    terminal: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: schemeChoice('terminal'),
        scrollSpeed: {
          type: 'number',
          minimum: 0.5,
          maximum: 5,
          description: 'Mouse wheel scroll speed multiplier for terminals. Default: 1.',
        },
        scrollbackLines: {
          type: 'integer',
          minimum: 1000,
          maximum: 100000,
          description: 'Lines of history each terminal keeps. Default: 10000.',
        },
        clipboardKeys: {
          type: 'string',
          enum: ['shift', 'smart'],
          description:
            'Terminal copy/paste keys on Linux and Windows. "shift": Ctrl+Shift+C/V, and Ctrl+C/V ' +
            'go to the program. "smart": Ctrl+C copies when text is selected (else interrupts), ' +
            'Ctrl+V pastes; Ctrl+Shift+C/V still work. macOS always uses Cmd+C/V. Default: shift.',
        },
        warnOnRiskyPaste: {
          type: 'boolean',
          description:
            'Ask before pasting two or more lines into a terminal from the clipboard. A single ' +
            'line is always pasted without its trailing newline or control characters. Only ' +
            'you can change this, in Settings; agents cannot. Default: true.',
        },
        minimumContrast: {
          type: 'number',
          minimum: 1,
          maximum: 21,
          description:
            'Lowest contrast ratio allowed between terminal text and its background; ' +
            'text below it is adjusted. 1 turns it off. Default: 1.',
        },
        prompt: {
          type: 'object',
          additionalProperties: false,
          description:
            'The prompt the input editor shows (behavior.inputMode "editor"). Arrange it in ' +
            'Settings → Prompt, or right-click the prompt and choose Edit prompt.',
          properties: {
            style: {
              type: 'string',
              enum: [...PROMPT_STYLES],
              description:
                '"shell" keeps your shell’s own prompt (PS1, prompt frameworks). "pine" shows ' +
                'context chips above the input editor, and new shells get a plain "cwd" prompt ' +
                'so scrollback stays readable. Terminals already open keep their prompt until ' +
                'a new shell starts. Default: shell.',
            },
            chips: {
              type: 'array',
              maxItems: MAX_PROMPT_CHIPS,
              uniqueItems: true,
              items: {
                type: 'string',
                anyOf: [
                  { enum: [...CORE_CHIP_IDS] },
                  { pattern: '^[a-z][a-z0-9-]{1,39}\\.[a-z][a-z0-9-]{0,39}$' },
                ],
              },
              description:
                'Chips in order, left to right. Built in: conda, virtualenv, node, cwd, user, ' +
                'host, kube (Kubernetes context), date, time12, time24, exitCode, duration. ' +
                'Extensions add chips as "<extension>.<chip>". Chips without a value are hidden. ' +
                'Default: ["conda", "virtualenv", "node", "cwd", "git.branch", "git.diff-stats"].',
            },
            sameLine: {
              type: 'boolean',
              description: 'Show the chips on the same line as the command. Default: false.',
            },
            separator: {
              type: 'string',
              enum: [...PROMPT_SEPARATORS],
              description:
                'Character after the prompt: in the plain shell prompt, and after the chips ' +
                'when sameLine is on. Default: none.',
            },
          },
        },
      },
    },
    panes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimInactive: {
          type: 'boolean',
          description: 'Dim panes that are not focused while a workspace is split. Default: true.',
        },
        focusOnHover: {
          type: 'boolean',
          description: 'Focus a pane after the pointer rests on it. Default: false.',
        },
        equalizeOnSplit: {
          type: 'boolean',
          description:
            'Resize every split in the workspace to equal shares when a pane is created. Default: false.',
        },
        hideTabClose: {
          type: 'boolean',
          description: 'Hide the close button on pane tabs. Default: false.',
        },
      },
    },
    notifications: {
      type: 'object',
      additionalProperties: false,
      properties: {
        desktop: { type: 'boolean', description: 'Show system notification banners.' },
        sound: { type: 'boolean', description: 'Play the system sound with each banner.' },
        whenFocused: {
          type: 'boolean',
          description: 'Also show banners for the pane you are looking at while Pine is focused.',
        },
        agentWaiting: {
          type: 'boolean',
          description:
            'Banner when an agent waits for your input or permission (pine state waiting).',
        },
        agentDone: {
          type: 'boolean',
          description: 'Banner when an agent finishes its turn (pine state done).',
        },
        command: {
          type: 'string',
          description:
            'Program run for every notification, e.g. "notify-send {title} {body}". Placeholders: ' +
            '{title}, {body}, {pane}. Runs the program directly, never through a shell. Empty ' +
            'turns it off. Only the human can change it, in Settings.',
        },
        commandFinished: {
          type: 'boolean',
          description: 'Banner when a long command finishes in a pane you are not watching.',
        },
      },
    },
    sidebar: {
      type: 'object',
      additionalProperties: false,
      properties: {
        showPath: { type: 'boolean', description: 'Show each workspace folder under its name.' },
        showMessage: {
          type: 'boolean',
          description: 'Show the latest notification or running command under each workspace.',
        },
        showDescription: {
          type: 'boolean',
          description: 'Show custom workspace descriptions.',
        },
        showExtensionItems: {
          type: 'boolean',
          description: 'Show items extensions add to a workspace row (git branch, counts).',
        },
        showSSH: {
          type: 'boolean',
          description:
            'Show the host a foreground ssh in the workspace is connected to (the Ports ' +
            'extension). Needs showExtensionItems.',
        },
      },
    },
    assistant: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatHistory: {
          type: 'boolean',
          description:
            'Save assistant chat sessions on this computer (never synced), so a chat pane ' +
            'reopens its last session and you can search, rename, export or delete past ones. ' +
            'Terminal output you add as context is stored only as the text that was sent. ' +
            'Off keeps chats in memory until Pine quits. Only you can change this; pine ' +
            'settings set refuses it. Default: true.',
        },
        mcpServers: {
          type: 'array',
          description:
            'MCP servers the assistant chat can call tools from. Each one runs a program from ' +
            'an argv (never a shell) or connects to an http(s) URL. Every tool call asks you ' +
            'in the chat first. Tokens go in Settings → Assistant (stored encrypted, ' +
            'never here). Only you can change this; pine settings set refuses it.',
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
    },
    agents: {
      type: 'object',
      additionalProperties: false,
      properties: {
        autoResume: {
          type: 'boolean',
          description:
            "Resume an agent session that was running when Pine quit, at its pane's first idle " +
            'prompt once the pane is visible. Only you can change this; pine settings set ' +
            'refuses it. Default: false.',
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
    },
    workspaces: {
      type: 'object',
      additionalProperties: false,
      properties: {
        placement: {
          type: 'string',
          enum: ['end', 'top', 'afterCurrent'],
          description:
            'Where a new workspace appears in the sidebar: "end" of the list, at the "top" ' +
            '(below pinned workspaces), or right "afterCurrent". Default: end.',
        },
        inheritFolder: {
          type: 'boolean',
          description:
            'Start a new workspace in the folder of the current workspace’s focused pane. ' +
            'Falls back to defaultFolder. Default: false.',
        },
        defaultFolder: {
          type: 'string',
          description: 'Folder a new workspace starts in. "~" is your home folder. Default: ~.',
        },
        confirmClose: {
          type: 'boolean',
          description: 'Ask before closing a workspace that has a running command. Default: true.',
        },
        confirmQuit: {
          type: 'boolean',
          description:
            'Ask before quitting or closing the window while commands are running. Default: true.',
        },
        closeToTray: {
          type: 'boolean',
          description:
            'Closing the window hides Pine instead of quitting; your terminals keep running and ' +
            'a tray icon brings the window back. Quit from the tray icon. Needs a desktop with a ' +
            'system tray. Default: false.',
        },
        wrapTitles: {
          type: 'boolean',
          description: 'Wrap long workspace titles onto up to two lines in the sidebar.',
        },
      },
    },
    browser: {
      type: 'object',
      additionalProperties: false,
      properties: {
        searchEngine: {
          type: 'string',
          enum: ['google', 'duckduckgo', 'bing', 'kagi', 'custom'],
          description:
            'Search engine for address-bar text that is not a URL. "custom" uses customSearchUrl. ' +
            'Default: google.',
        },
        customSearchUrl: {
          type: 'string',
          description:
            'Search URL for the "custom" engine: http or https, containing {query}, e.g. ' +
            '"https://example.com/search?q={query}". An invalid template falls back to Google.',
        },
        openTerminalLinks: {
          type: 'boolean',
          description:
            'Ctrl/Cmd+click on a web link in a terminal opens it in Pine’s browser pane instead of ' +
            'the system browser. Default: false.',
        },
        defaultZoom: {
          type: 'number',
          minimum: 50,
          maximum: 300,
          description: 'Page zoom in percent for browser panes when a page loads. Default: 100.',
        },
      },
    },
    editor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: schemeChoice('editor'),
        wordWrap: { type: 'string', enum: ['off', 'on'], description: 'Wrap long lines.' },
        lineNumbers: {
          type: 'string',
          enum: ['on', 'off', 'relative'],
          description: 'Line number gutter. "relative" counts lines from the cursor.',
        },
        tabSize: { type: 'number', enum: [2, 4, 8], description: 'Spaces per tab stop.' },
        insertSpaces: {
          type: 'boolean',
          description: 'Insert spaces when Tab is pressed instead of a tab character.',
        },
        autoSave: {
          type: 'string',
          enum: ['off', 'afterDelay', 'onFocusChange'],
          description:
            'Save changed files by themselves: "afterDelay" one second after the last edit, ' +
            '"onFocusChange" when the editor loses focus. Default: off.',
        },
        formatOnSave: {
          type: 'boolean',
          description:
            'Format the document before every save with the language server or built-in ' +
            'formatter. Files with no formatter are just saved. Default: false.',
        },
        openFilesIn: {
          type: 'string',
          enum: ['tab', 'split'],
          description:
            'Where an opened file shows: "tab" as a tab next to the focused pane (reusing an ' +
            'editor tab already there), "split" in the workspace editor pane, split to the ' +
            'right when there is none. Default: tab.',
        },
      },
    },
    keybindings: keybindingsSchema(Object.keys(DEFAULT_CHORDS)),
    workspaceGroups: {
      type: 'object',
      additionalProperties: false,
      properties: {
        byCwd: {
          type: 'array',
          description:
            'Put each new workspace into a sidebar group by its folder. The first rule whose ' +
            'pattern matches the workspace folder wins; the group is created if it does not ' +
            'exist. "*" matches within one folder name, "**" across folders, "?" one character.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['pattern', 'group'],
            properties: {
              pattern: {
                type: 'string',
                description: 'Glob matched against the whole workspace folder, e.g. ~/work/**.',
              },
              group: { type: 'string', description: 'Name of the group to put the workspace in.' },
            },
          },
        },
      },
    },
    extensionSettings: {
      type: 'object',
      description:
        'Extension id → its setting values. Edit them in Settings → Extensions; each ' +
        "extension's manifest lists its settings.",
      additionalProperties: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
      },
    },
    sync: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: {
          type: 'string',
          description:
            'Folder to sync settings and extension choices through (a git repository, ' +
            'Syncthing or Dropbox folder). Empty turns sync off. Set it from Settings → Sync; ' +
            'agents cannot change it. Secrets and capability grants never sync.',
        },
      },
    },
    actions: {
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
            description: 'A palette command id (see pine commands), e.g. "pane.split".',
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
              enum: ['terminal', 'editor', 'browser', 'extension', 'diff', 'view'],
            },
            description: 'Only show it on these pane kinds. Default: all.',
          },
        },
      },
    },
    manager: {
      type: 'object',
      additionalProperties: false,
      description:
        'The manager: one agent you start with `pine <agent>` from a terminal outside Pine. ' +
        'Only you can change this (Settings → Manager); agents cannot set it.',
      properties: {
        agents: {
          type: 'object',
          description:
            'Presets for `pine <name>` and for the workers the manager starts: a name mapped to ' +
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
    },
    trustedActions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Actions you chose "Run and trust" for. Only you can change this; it never syncs.',
    },
    approvals: {
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
    },
    capabilities: {
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
          description:
            'Elevated capabilities pre-granted to every pane (pane-scoped defaults already ' +
            'cover the rest). Human-edited only; restart Pine to apply.',
        },
      },
    },
  },
}

export function fullSettingsSchema() {
  return {
    ...SETTINGS_JSON_SCHEMA,
    properties: {
      ...SETTINGS_JSON_SCHEMA.properties,
      keybindings: keybindingsSchema(bindableIds()),
    },
  }
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>
  additionalProperties?: boolean | SchemaNode
  [key: string]: unknown
}

export function settingsSchemaAt(path?: string): unknown {
  let node = fullSettingsSchema() as unknown as SchemaNode
  for (const key of (path ?? '').split('.').filter(Boolean)) {
    const extra = node.additionalProperties
    const next = node.properties?.[key] ?? (typeof extra === 'object' ? extra : undefined)
    if (!next) throw new Error(`unknown settings key: ${path}`)
    node = next
  }
  return node
}
