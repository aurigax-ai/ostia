import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { GIT_POLL_SECONDS } from '@shared/boards/git'
import { PORTS_INTERVAL_SECONDS } from '@shared/boards/ports'
import { GLOBAL_HOTKEY_MAX_LENGTH } from '@shared/keyboard/globalHotkey'
import {
  BREADCRUMB_STYLES,
  EXCLUDE_MAX,
  FILE_SORT_BYS,
  FILE_SORT_ORDERS,
  NESTING_MAX,
  PATTERN_MAX_LENGTH,
} from './fileTreeSettings'

export const filesSchema = {
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
    searchIgnored: {
      type: 'boolean',
      description:
        'Search in the Files panel also looks in files .gitignore leaves out. Default: false.',
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
    breadcrumb: {
      type: 'string',
      enum: [...BREADCRUMB_STYLES],
      description:
        'The Files header path, on one line. auto shortens folder names to their first ' +
        'letter and then folds the leading ones into … only when the path does not fit; ' +
        'full never shortens and scrolls; short always shortens. Default: auto.',
    },
    iconTheme: {
      type: 'string',
      description:
        'File icon theme: "ostia" (built-in) or the id of a VS Code icon theme an enabled ' +
        'extension contributes (contributes.iconThemes). Default: ostia.',
    },
  },
}

export const sidebarSchema = {
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
}

export const workspacesSchema = {
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
      description: `Closing the window hides ${PRODUCT_DISPLAY_NAME} instead of quitting; your terminals keep running and a tray icon brings the window back. Quit from the tray icon. Needs a desktop with a system tray. Default: true.`,
    },
    globalHotkey: {
      type: 'string',
      maxLength: GLOBAL_HOTKEY_MAX_LENGTH,
      description: `A system-wide shortcut that brings every ${PRODUCT_DISPLAY_NAME} window up, or hides them to the tray when one has focus, e.g. "Ctrl+Alt+Space". Modifiers: Ctrl, Alt, Shift, Super, Cmd, Mod (Cmd on macOS, Ctrl elsewhere); needs one other than Shift. On Wayland it works only where the desktop lets apps register global shortcuts. Empty turns it off. Only you can change this, in Settings; agents cannot. Default: empty.`,
    },
    wrapTitles: {
      type: 'boolean',
      description: 'Wrap long workspace titles onto up to two lines in the sidebar.',
    },
  },
}

export const workspaceGroupsSchema = {
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
}

export const gitSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Git: the branch and diff stats of each workspace and the Git panel. Only you can change this (Settings → Git).',
  properties: {
    enabled: { type: 'boolean', description: 'Default: true.' },
    pollSeconds: {
      type: 'number',
      minimum: GIT_POLL_SECONDS.min,
      maximum: GIT_POLL_SECONDS.max,
      description: 'Seconds between refreshes while a window is focused. Default: 10.',
    },
    showDiffStats: {
      type: 'boolean',
      description: 'Diff stats of the active workspace in the top bar. Default: true.',
    },
    graphScope: {
      type: 'string',
      enum: ['current', 'all'],
      description: 'Branches the commit graph shows. Default: current.',
    },
    changesView: {
      type: 'string',
      enum: ['list', 'tree'],
      description: 'Changed files as a flat list or a folder tree. Default: list.',
    },
  },
}

export const portsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Listening ports and ssh logins of your terminals. Only you can change this (Settings → Ports).',
  properties: {
    enabled: { type: 'boolean', description: 'Default: true.' },
    intervalSeconds: {
      type: 'number',
      minimum: PORTS_INTERVAL_SECONDS.min,
      maximum: PORTS_INTERVAL_SECONDS.max,
      description: 'Seconds between scans while a window is focused. Default: 3.',
    },
    portHost: {
      type: 'string',
      enum: ['localhost', '127.0.0.1'],
      description: 'Host used to open a port in the browser pane. Default: localhost.',
    },
  },
}
