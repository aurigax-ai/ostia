import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import {
  BELL_FLASH_EASINGS,
  BELL_FLASH_MAX_MS,
  BELL_FLASH_MIN_MS,
  BELL_MODES,
  LONG_COMMAND_MAX_SECONDS,
  LONG_COMMAND_MIN_SECONDS,
} from '@shared/app/notificationSettings'
import {
  CORE_CHIP_IDS,
  MAX_PROMPT_CHIPS,
  PROMPT_SEPARATORS,
  PROMPT_STYLES,
} from '@shared/terminal/promptSettings'
import {
  SCROLLBACK_HISTORY_MAX_MIB,
  SCROLLBACK_HISTORY_MIN_MIB,
} from '@shared/terminal/scrollbackHistory'
import { SHELL_SETTING_MAX_LENGTH } from '@shared/terminal/terminalShell'
import { schemeChoice } from './appearanceSchema'

export const terminalSchema = {
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
      description:
        'Lines each terminal keeps in memory; older output moves to history on disk ' +
        '(scrollbackHistory). Default: 10000.',
    },
    scrollbackHistory: {
      oneOf: [
        { type: 'string', enum: ['off', 'unlimited'] },
        {
          type: 'integer',
          minimum: SCROLLBACK_HISTORY_MIN_MIB,
          maximum: SCROLLBACK_HISTORY_MAX_MIB,
        },
      ],
      description:
        'Output older than the lines in memory, kept per pane on this machine, encrypted with a ' +
        'key that lives only while the app runs, and removed when the pane closes, the app ' +
        'quits or the program clears its scrollback. "off": no history on disk. "unlimited": ' +
        'bounded only by keeping 2 GiB of disk free. A number: MiB per pane. Only you can change ' +
        'this, in Settings; agents cannot. Default: unlimited.',
    },
    clipboardKeys: {
      type: 'string',
      enum: ['shift', 'smart'],
      description:
        'Terminal copy/paste keys on Linux and Windows. "shift": Ctrl+Shift+C/V, and Ctrl+C/V ' +
        'go to the program. "smart": Ctrl+C copies when text is selected (else interrupts), ' +
        'Ctrl+V pastes; Ctrl+Shift+C/V still work. macOS always uses Cmd+C/V. Default: shift.',
    },
    linkClick: {
      type: 'string',
      enum: ['app', 'system'],
      description:
        'Where Ctrl+click (Cmd+click on macOS) opens a web link or a printed file path in a ' +
        `terminal. "app": in ${PRODUCT_DISPLAY_NAME} (a new browser tab, or the editor for a file), and adding ` +
        'Shift opens it in the system\'s default app. "system": in the system\'s default app, ' +
        `and adding Shift opens it in ${PRODUCT_DISPLAY_NAME}. Default: app.`,
    },
    warnOnRiskyPaste: {
      type: 'boolean',
      description:
        'Ask before pasting two or more lines into a terminal from the clipboard. A single ' +
        'line is always pasted without its trailing newline or control characters. Only ' +
        'you can change this, in Settings; agents cannot. Default: true.',
    },
    primarySelection: {
      type: 'boolean',
      description:
        'Linux: selecting terminal text puts it in the primary selection, and a middle ' +
        'click pastes the primary selection (through the same paste check as Ctrl+Shift+V). ' +
        'Off turns both off. Default: true.',
    },
    macOptionIsMeta: {
      type: 'boolean',
      description:
        'macOS: send Option+key as Meta (Esc+key) so readline and fzf Alt shortcuts work; ' +
        'Option then no longer types special characters. Default: false.',
    },
    renderer: {
      type: 'string',
      enum: ['xterm', 'ghostty'],
      description:
        'Experimental. Engine for terminals opened from now on and terminals restored at ' +
        'the next start; an open terminal keeps its engine. "ghostty" runs Ghostty\'s own ' +
        'emulator (libghostty-vt) and falls back to "xterm" if it cannot start. Default: "xterm".',
    },
    keepShells: {
      type: 'boolean',
      description:
        'Experimental. Run new terminals in a private tmux server (tmux 3.2 or newer) so ' +
        'restarting for an update or a crash leaves them running. With confirmQuit on, Quit ' +
        'asks whether to keep them for the next start or end them; otherwise Quit ends them. ' +
        'Only you can change this, in Settings; agents cannot. Default: false.',
    },
    osc52Write: {
      type: 'boolean',
      description:
        'Let programs in a terminal set the clipboard with OSC 52 (tmux, vim and agents ' +
        'over ssh copy this way). Programs can never read the clipboard. Only you can ' +
        'change this, in Settings; agents cannot. Default: true.',
    },
    shell: {
      type: 'string',
      maxLength: SHELL_SETTING_MAX_LENGTH,
      description:
        'Program new terminals run, with its arguments, e.g. "/usr/bin/fish" or "nu -l". ' +
        'Empty uses your login shell ($SHELL). Run directly, never through a shell. Blocks, ' +
        'the input editor and the folder chip need zsh or bash; other shells work without ' +
        'them. Applies to new terminals. Only you can change this, in Settings; agents ' +
        'cannot. Default: empty.',
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
            '"shell" keeps your shell’s own prompt (PS1, prompt frameworks). "ostia" shows ' +
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
}

export const panesSchema = {
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
}

export const notificationsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    desktop: { type: 'boolean', description: 'Show system notification banners.' },
    sound: { type: 'boolean', description: 'Play the system sound with each banner.' },
    whenFocused: {
      type: 'boolean',
      description: `Also show banners for the pane you are looking at while ${PRODUCT_DISPLAY_NAME} is focused.`,
    },
    agentWaiting: {
      type: 'boolean',
      description: 'Banner when an agent waits for your input or permission (ostia state waiting).',
    },
    agentDone: {
      type: 'boolean',
      description: 'Banner when an agent finishes its turn (ostia state done).',
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
      description:
        'Banner when a long command (longCommandSeconds or more) finishes in a pane you ' +
        'are not watching.',
    },
    longCommandSeconds: {
      type: 'integer',
      minimum: LONG_COMMAND_MIN_SECONDS,
      maximum: LONG_COMMAND_MAX_SECONDS,
      description: `Seconds a command must run before its end notifies you while ${PRODUCT_DISPLAY_NAME} is in the background. Default: 10.`,
    },
    bell: {
      type: 'string',
      enum: [...BELL_MODES],
      description:
        'What a terminal bell (BEL) does: "attention" marks the pane when you are not ' +
        'viewing it, "sound" also plays the system sound, "off" neither marks nor plays a sound ' +
        '(visualBell is separate). Default: attention.',
    },
    visualBell: {
      type: 'boolean',
      description:
        'Flash the pane briefly when a terminal bell (BEL) rings, independent of the bell ' +
        'setting above. Never flashes while reduced motion is on; a run of bells flashes ' +
        'once. Default: false.',
    },
    visualBellMs: {
      type: 'integer',
      minimum: BELL_FLASH_MIN_MS,
      maximum: BELL_FLASH_MAX_MS,
      description: 'Milliseconds one visual bell flash lasts. Default: 200.',
    },
    visualBellEasing: {
      type: 'string',
      enum: [...BELL_FLASH_EASINGS],
      description: 'How the visual bell flash fades out. Default: out.',
    },
  },
}
