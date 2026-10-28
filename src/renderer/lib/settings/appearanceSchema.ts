import { BUILTIN_COLOR_SCHEMES } from '@/lib/colorSchemes/builtinColorSchemes'
import { MATCH_OSTIA_THEME } from '@/lib/theme/themeChoice'

const font = (title: string) => ({
  type: 'object',
  title,
  additionalProperties: false,
  properties: {
    family: { type: 'string', description: 'Font family name.' },
    size: { type: 'number', minimum: 8, maximum: 32, description: 'Font size in px.' },
    baseSize: {
      type: 'number',
      minimum: 8,
      maximum: 32,
      description:
        'Font size in px that Cmd/Ctrl+scroll zoom returns to. Set while the size is zoomed, ' +
        'removed when the zoom is reset or the size is changed in Settings.',
    },
    weight: {
      type: 'number',
      enum: [300, 400, 450, 500, 600, 700],
      description:
        'Body text weight. In the UI, emphasis and headings step up from it (+100, +200).',
    },
  },
})

export const schemeChoice = (surface: string) => ({
  type: 'string',
  examples: [MATCH_OSTIA_THEME, ...BUILTIN_COLOR_SCHEMES.map((s) => s.id)],
  description: [
    `Color scheme for the ${surface}.`,
    `"${MATCH_OSTIA_THEME}" uses the scheme of appearance.theme (following its light/dark switch);`,
    'a scheme id such as catppuccin-mocha keeps that scheme whatever the app theme is.',
    `An unknown id falls back to the app theme's scheme. Default: ${MATCH_OSTIA_THEME}.`,
  ].join(' '),
})

export const appearanceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    theme: {
      type: 'string',
      description:
        'Theme id (built-in: adeberry, one-dark-vivid, instrument-night, dracula, oxocarbon, ostia-light; ' +
        'or an extension theme). Default: adeberry.',
    },
    followSystem: {
      type: 'boolean',
      description:
        'Switch between lightTheme and darkTheme when the operating system switches. When ' +
        'off, "theme" is used. Default: true.',
    },
    lightTheme: {
      type: 'string',
      description:
        'Theme id used when the OS is light and followSystem is on. Default: ostia-light.',
    },
    darkTheme: {
      type: 'string',
      description: 'Theme id used when the OS is dark and followSystem is on. Default: adeberry.',
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
}

export const behaviorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursorStyle: {
      type: 'string',
      enum: ['block', 'underline', 'bar'],
      description: 'Terminal cursor shape.',
    },
    cursorBlink: { type: 'boolean', description: 'Blink the terminal cursor.' },
    wheelSmoothScroll: {
      type: 'boolean',
      description:
        'Animate terminal scrollback for a physical mouse wheel, never for a trackpad and ' +
        'never when reduced motion is on. Default: off.',
    },
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
    inputEscape: {
      type: 'string',
      enum: ['clear', 'menus'],
      description:
        'What Esc does in the input editor when the Ostia prompt holds a draft. "clear": the ' +
        'first Esc closes a menu or suggestion, then Esc twice within a second clears the ' +
        'draft and Ctrl+Z right after restores it. "menus": Esc only closes menus and ' +
        'suggestions. Vim keys keep Esc for normal mode. Default: clear.',
    },
    liveFileSuggestions: {
      type: 'boolean',
      description:
        'Open the input editor’s file menu by itself while you type a path (a word with a ' +
        '/, or starting with ~ or .), after a short pause. Tab or Right arrow takes the ' +
        'selected entry; Enter always runs the line. Default: true.',
    },
    historySuggestions: {
      type: 'boolean',
      description:
        'Suggest commands from this session and from the shell’s history file in the input ' +
        'editor: gray text (Right arrow or End accepts it), Tab arguments and Up. When false ' +
        'the history file is not read. Default: true.',
    },
    copyOnSelect: {
      type: 'boolean',
      description: 'Copy selected terminal text to the clipboard as soon as it is selected.',
    },
    wheelZoom: {
      type: 'boolean',
      description:
        'Hold Cmd (macOS) or Ctrl and scroll over a terminal or the editor to change its ' +
        'font size. Default: off on macOS, on elsewhere.',
    },
    gpuAcceleration: {
      type: 'boolean',
      description:
        'Draw terminals on the GPU (WebGL). Block and box-drawing characters then fill ' +
        'their cells exactly. Falls back to the DOM renderer (the canvas renderer with the ' +
        'ghostty engine) when WebGL is unavailable or runs in software. Applies to new ' +
        'terminals.',
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
        'Ask GitHub once after launch and then once an hour whether a newer release exists, ' +
        'and show a notice when one does. Nothing is downloaded or installed. Only you can ' +
        'change this, in Settings → About. Default: true.',
    },
    updateChannel: {
      type: 'string',
      enum: ['stable', 'beta', 'main'],
      description:
        'Which builds the update check offers. "stable" offers releases only. "beta" also ' +
        'offers release candidates and installs them in the app: macOS (the dmg or ' +
        'Homebrew install, shown as "Receive beta updates") and the Linux tarball or a ' +
        'local build. "main" (the Linux tarball or a local build) also offers the daily ' +
        'build of the main branch and release candidates. A newer release is offered on ' +
        'every channel. apt stays on stable. Only you can change this, in Settings → ' +
        'About. Default: stable.',
    },
    discreteGpu: {
      type: 'boolean',
      description:
        'Linux: run the app on the discrete GPU that switcheroo-control lists. Needs ' +
        'switcheroo-control. Programs in terminals keep the default GPU. When another GPU ' +
        'drives the screen (most laptops), every frame is copied between the GPUs, which ' +
        'adds latency to terminal text and scrolling. Applies on the next start. Only you ' +
        'can change this, in Settings → Terminal. Default: false.',
    },
    externalEditor: {
      type: 'string',
      description:
        'Command for "Open in External Editor". "auto" picks the first of code, cursor, zed ' +
        'on PATH; empty turns it off. Placeholders: {file}, {line}, {column}, e.g. ' +
        '"code -g {file}:{line}:{column}". Runs the program directly, never through a shell.',
    },
  },
}
