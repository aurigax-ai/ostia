# Settings gap: Pine vs cmux and Warp

This is a list of the settings cmux or Warp has that Pine lacks or has only in part, taken on
2026-09-30. Pine's side comes from `src/renderer/settings/settingsSchema.ts`, the Settings panel
sections, the built-in extensions' `contributes.settings` and `DEFAULT_CHORDS`
(`src/renderer/lib/chords.ts`). cmux's side comes from its source (upstream `manaflow-ai/cmux`,
shallow clone). Warp's side comes from docs.warp.dev.

A row is listed only when cmux or Warp has the setting and Pine lacks it or has it partly. A
feature that exists but has no toggle counts as a missing setting only if a toggle would
matter. "Worth adding?" is judged against `PRODUCT.md` and the CLAUDE.md §4 invariants.

**Source keys**
- `C:S`: cmux's `web/data/cmux.schema.json`, the schema for `~/.config/cmux/cmux.json`.
- `C:K/<X>`: cmux's `Packages/macOS/CmuxSettings/Sources/CmuxSettings/Keys/<X>CatalogSection.swift`.
- `C:SC`: cmux's `web/data/cmux-shortcuts.ts`.
- `C:<doc>`: cmux's `docs/<doc>.md`.
- `W:<path>`: `https://docs.warp.dev<path>`. Most Warp keys are on `W:/terminal/settings/all-settings/`.

Status values: **partial** (followed by what's missing) and **missing**.

**Left out on purpose.** These are settings Pine already has: quit confirmation, input mode,
where opened files go, assistant model choice and bring-your-own key, and command suggestions.
Also left out are Warp's agent-side settings: execution profiles, command allow/deny lists,
rules, MCP, codebase indexing and computer use. Those belong to the agent CLIs Pine hosts; see
ROADMAP §3, "Built-in AI chat: not planned". Telemetry is out too, because Pine sends none.

## Appearance and themes

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Custom theme files (user-authored theme on disk) | Ghostty `theme` files, `cmux themes set` (C:customizing-appearance) | YAML themes in `themes/` (W:/terminal/appearance/custom-themes/) | partial: 6 built-in themes, 26 terminal/editor schemes, plugin themes; there's no user theme file format | yes: data-only theme files fit the lean-core model (a `contributes.themes` data contribution) |
| Window opacity / blur | Ghostty `background-opacity`, `background-blur` (C:customizing-appearance) | `appearance.window.override_opacity`, `override_blur` (W:/terminal/appearance/size-opacity-blurring/) | missing | maybe: opacity is cheap in Electron; blur isn't portable on Linux |
| Background image | Ghostty `background-image`, `-opacity`, `-fit`, `-position` | theme `background_image` (W:/terminal/appearance/custom-themes/) | missing | no: decorative, against "no decorative noise" (PRODUCT.md) |
| Terminal padding | Ghostty `window-padding-x/-y/-balance` | `alt_screen_padding` (W:/terminal/more-features/full-screen-apps/) | missing: fixed padding, and the left padding holds the block gutter | maybe: only right/top/bottom padding; the left one is the gutter |
| Pane border / divider colors | `paneBorderColor`, `activePaneBorderColor`, Ghostty `split-divider-color` (C:S) | via theme | missing: comes from tokens only | no: tokens, not per-user colors (docs/DESIGN.md) |
| Inactive pane dim amount | Ghostty `unfocused-split-opacity`, `unfocused-split-fill` | `should_dim_inactive_panes` (on/off) | partial: `panes.dimInactive` is on/off with no amount | maybe: an amount slider is cheap |
| App icon variant | `app.appIcon` automatic/light/dark (C:S) | `appearance.icon.app_icon` (W:/terminal/appearance/app-icons/) | missing | no: brand, not a preference |
| Minimal mode / titlebar style | `app.minimalMode`, `app.titlebarControlsStyle` (C:S, C:K/App) | tab bar visibility (W:/terminal/appearance/tabs-behavior/) | missing | maybe: hiding the top bar for more rows suits density |
| Sidebar tint / material | `sidebarAppearance.*` tint, opacity, match terminal bg (C:S) | none | missing | no: chrome comes from tokens |
| Workspace color indicator style | `workspaceColors.indicatorStyle`, `selectionColor`, palette (C:S) | tab color per directory `directory_tab_colors` (W:/terminal/appearance/tabs-behavior/) | partial: groups have colors, single workspaces don't | maybe: a per-workspace color mark, never hue-alone (PRODUCT.md a11y) |
| Block spacing / compact mode | none | `appearance.spacing`, `show_block_dividers` (W:/terminal/appearance/blocks-behavior/) | missing | maybe: block dividers help to read long scrollback |
| Input position (pinned top/bottom) | none | `appearance.input.input_mode` (W:/terminal/appearance/input-position/) | missing: the input editor stays in place over the shell line | no: the editor never takes layout space or resizes the pty (§4) |
| Window size for new windows | Ghostty `window-width/height` ignored | `new_windows_num_columns/rows` (W:/terminal/settings/all-settings/) | missing: detached windows reopen on their saved display | no: little value; windows are restored |

## Fonts and text

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Terminal ligatures / font features | Ghostty `font-feature` | `ligature_rendering_enabled` (W:/terminal/appearance/text-fonts-cursor/) | missing: Monaco has ligatures, xterm doesn't | maybe: xterm needs the ligatures addon, and it only works with the DOM/canvas renderer |
| Thin strokes / font thicken | Ghostty `font-thicken` | `use_thin_strokes` (macOS) | missing | no: macOS-only rendering hack |
| Sidebar / tab bar font size | `sidebar-font-size`, `surface-tab-bar-font-size` (C:customizing-appearance) | none | partial: `appearance.ui` sets one UI font and size for all chrome | no: `appearance.zoom` + UI font cover it; the type scale is fixed (DESIGN.md) |
| Markdown viewer font / width | `markdown.fontSize`, `fontFamily`, `maxWidth` (C:S) | none | missing: the preview uses the UI font | maybe: a max width helps wide panes |
| Chat / AI font | `agentChat.fonts.*` (C:S) | `ai_font_name`, `match_ai_font` | missing: the chat pane uses the UI font | no: one UI font is the rule |
| Cursor color / text color | Ghostty `cursor-color`, `cursor-text`, `cursor-opacity` | theme `cursor` | partial: comes from the terminal scheme only | no: schemes cover it |

## Terminal behavior

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Shell to launch | Ghostty `command` (honored) | `startup_shell_override`, `new_session_shell_override` (W:/terminal/settings/all-settings/) | missing: always `$SHELL` (`main/index.ts`) | yes: basic; fish/nu users run without integration, but it still works (§4) |
| Working directory for new panes/tabs/windows | `app.workspaceInheritWorkingDirectory` (C:S) | `session.working_directory_config.{split_pane,new_tab,new_window}` (W:/terminal/more-features/working-directory/) | partial: `workspaces.inheritFolder`/`defaultFolder` for new workspaces; new panes always use the workspace `workDir` | maybe: "home / workDir / focused pane cwd" for splits |
| Per-workspace environment variables | `--env`, layout `env` (C:cli-contract) | tab configs set env (W:/terminal/windows/tab-configs/) | missing | maybe: pairs with launch layouts; values must never sync if secret |
| Audible / visual bell | Ghostty bell | `terminal.use_audible_bell` (W:/terminal/more-features/audible-bell/) | partial: BEL raises attention; there's no sound or off switch | yes: a "bell: attention / sound / off" choice |
| Scrollbar visibility | `terminal.showScrollBar` (C:S) | none | missing | maybe: cheap CSS switch |
| Max content width / alignment | `terminal.sessionContentMaxWidth`, `sessionContentAlignment` (C:S) | none | missing | no: it changes cols; every size change is a resize (§6) and wide panes are the point of splits |
| Option/Alt as Meta | Ghostty `macos-option-as-alt` | `extra_meta_keys` (W:/terminal/settings/all-settings/) | missing: xterm `macOptionIsMeta` unset | yes (macOS): Alt+letter readline/fzf keys need it |
| Smart double-click selection / word characters | Ghostty `selection-word-chars` | `smart_select.enabled`, `word_char_allowlist` (W:/terminal/more-features/text-selection/) | missing: xterm defaults | maybe: path/URL-aware selection helps with agent output |
| Middle-click paste / primary selection (Linux) | n/a (macOS) | `middle_click_paste_enabled`, `linux_selection_clipboard` | missing as a setting | yes: Linux-first product |
| Right-click behavior | Ghostty `right-click-action` | `right_click_behavior` | missing: always the context menu | maybe: "paste" or "select word" options |
| OSC 52 clipboard access | Ghostty `clipboard-read/-write` | `osc52_clipboard_access` | missing: OSC 52 isn't handled | yes: agents over ssh/tmux copy through it; default "write only, ask to read" |
| Mouse / scroll / focus reporting to TUIs | Ghostty defaults | `mouse_reporting_enabled`, `scroll_reporting_enabled`, `focus_reporting_enabled` | missing: xterm always reports | no: agent TUIs rely on it; nobody asks to break them |
| Reflow hard wraps on copy | `terminal.reflowHardWrapOnCopy` (C:S) | none | missing | maybe: copying wrapped agent output is common |
| Password prompt indicator | `showPasswordInputIndicator`, `showPasswordInputDots` (C:S) | password prompt notification (W:/terminal/more-features/notifications/) | missing | maybe: pairs with notifications (see below) |
| Predictive local echo over ssh | `terminal.predictiveLocalEcho` (C:S) | none | missing | no: large, risky, and Pine isn't a remote client |
| Link hover tooltip | none | `general.link_tooltip` | partial: Ctrl/Cmd+click works; no tooltip toggle | no: no need for a switch |
| Launch at login | none (macOS login items) | `login_item` | missing: `--hidden` start exists but no autostart setting | maybe: with close-to-tray it makes Pine a resident app |
| Undo close pane/tab | reopen browser tab ⌘⇧T (C:SC) | `undo_close.enabled`, `grace_period` | missing | maybe: only the layout and scrollback; the shell is gone (nothing live is restored, §4) |
| Close tab confirmation modes | `warnBeforeClosingTab`, `warnBeforeClosingTabXButton`, `warnBeforeClosingWindow` (C:S) | `should_confirm_close_session` | partial: `confirmClose`/`confirmQuit` cover workspaces and quit; a pane with a running command always asks | no: asking only about running commands is the invariant (§4) |
| SSH / subshell integration | remote tmux beta, `uploadCommands` for scp on drop (C:S) | Warpify ssh/subshells (W:/terminal/warpify/ssh/) | missing: blocks stop inside ssh | maybe: large; the `ports` ssh chip is there already |
| GPU / renderer memory | `rendererRealization.*`, runaway memory guardrail (C:S, C:K/Terminal) | `prefer_low_power_gpu` | partial: `behavior.gpuAcceleration` on/off; agent hibernation frees ptys | no: hibernation covers the memory case |
| Screen reader verbosity | macOS VoiceOver | `accessibility_verbosity` (W:/terminal/more-features/accessibility/) | missing: xterm `screenReaderMode` not exposed | yes: WCAG AA target (PRODUCT.md); xterm has the mode built in |
| File drop behavior | `app.fileDropDefaultBehavior` (C:K/App) | none | partial: always pastes shell-quoted paths | no: the drop is the human's paste (§4); one behavior is enough |

## Input editor and completions

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Syntax highlighting on/off | none | `terminal.input.syntax_highlighting` (W:/terminal/editor/syntax-error-highlighting/) | partial: always on in the input editor | no: no one turns it off; skip the switch |
| Error underlining (unknown command) | none | `error_underlining_enabled` | missing | maybe: the command list from `pty:commands` already exists |
| Completions open while typing | none | `completions_open_while_typing` (W:/terminal/command-completions/completions/) | missing: completion opens on Tab only | yes: cheap switch on existing specs |
| Native shell completions | none | `native_shell_completions_enabled` | missing (ROADMAP §3 "not started") | yes: already on the roadmap |
| History autosuggestions on/off | none | `autosuggestions.enabled`, `keybinding_hint` (W:/terminal/command-completions/autosuggestions/) | partial: the assistant's `terminalCompletions` switches AI ghost text; history suggestions have no switch | yes: some users keep zsh-autosuggestions |
| Alias expansion | none | `alias_expansion_enabled` (W:/terminal/editor/alias-expansion/) | missing | no: needs the shell's alias table in main; small gain |
| Command corrections | none | `command_corrections` (W:/terminal/entry/command-corrections/) | missing | maybe: as an assistant feature, suggested, never run |
| Auto-close brackets and quotes | none | `text_editing.autocomplete_symbols` | missing | maybe: cheap; must default off for shell users |
| Vim: system clipboard / status bar | none | `vim_unnamed_system_clipboard`, `vim_status_bar` (W:/terminal/editor/vim/) | partial: `behavior.inputEditorVim` on/off only | maybe: clipboard register is small |
| Natural-language auto-detection | none | `ai_auto_detection_enabled`, `ai_command_denylist` | partial: explicit `# ` prefix only | no: explicit is safer; assist requests carry only what the human put in (§4) |
| Input box max lines | `terminal.textBoxMaxLines` (C:S) | none | missing | maybe: tall drafts scroll xterm locally today |
| Submit actions (send draft to agent, run, etc.) | `textBoxSubmitActions`, `textBoxDefaultSubmitAction` (C:S) | Rich Input `submit_on_ctrl_enter` (W:/agents/cli-agents/rich-input/) | partial: the assist composer pastes into agents without Enter | maybe: a "Ctrl+Enter submits" option for the composer |

## Blocks

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Jump-to-bottom button on long output | none | `show_jump_to_bottom_of_block_button` (W:/terminal/appearance/blocks-behavior/) | missing | maybe: fits the sticky header |
| Block dividers | none | `show_block_dividers` | missing | maybe: see Appearance |
| Keep input focus when a block is selected | none | `preserve_input_focus_on_block_selection` | missing: fixed behavior | no: one behavior is enough |
| Secret redaction in blocks | none | `privacy.secret_redaction.*`, `custom_secret_regex_list` (W:/support-and-community/privacy-and-security/secret-redaction/) | missing | yes: agents print tokens; redact in copy, reports and sent context |

## Panes, tabs and windows

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Tab bar visibility (always / 2+ tabs) | `app.tabBarVisibility` (C:S) | `workspace_decoration_visibility` (W:/terminal/appearance/tabs-behavior/) | partial: `panes.hideTabClose` only | maybe: cheap |
| New tab placement | `forkConversationDefaultDestination` (C:S) | `general.new_tab_placement` | missing | maybe: "after current / end" |
| Pane resize step (keyboard) | `app.paneResizeStepPixels` (C:S) | none | missing: no keyboard pane resize at all | maybe: add the command first (see Keyboard) |
| Focus history across panes and tabs | `focusHistoryIncludesPanesAndTabs` (C:S) | Ctrl+Tab recent vs next `ctrl_tab_behavior_setting` | missing | maybe: with pane-cycle commands |
| Rename selects the old name | `app.renameSelectsExistingName` (C:S) | none | missing: fixed | no |
| Palette searches every surface | `commandPaletteSearchesAllSurfaces` (C:S) | none | missing | maybe: "go to pane" in the palette |
| Global hotkey (show/hide all windows) | `showHideAllWindows` (C:SC) | `global_hotkey.toggle_all_windows` (W:/terminal/windows/global-hotkey/) | missing | yes: pairs with close-to-tray; Electron `globalShortcut` (X11; Wayland only through the desktop's portal) |
| Quake / dropdown window | none | `global_hotkey.dedicated_window.*` | missing | no: large, and a second terminal model |
| Launch layouts / tab configs | `commands` with layout, cwd, env, color (C:S; docs site custom-commands) | tab configs (W:/terminal/windows/tab-configs/), launch configurations | partial: restore brings back the last layout; there are no named layouts to start from | yes: "New workspace from layout", data only, cmds typed only at the first idle prompt (`runWhenIdle`) |
| Free-form canvas layout | `canvas.paneGap`, `snappingEnabled` (C:S) | none | missing | no: splits and tabs are the model |

## Workspaces and sidebar

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Reorder workspaces on activity | `app.reorderOnNotification` (C:S) | none | missing | maybe: "jump to latest unread" covers most of it |
| New workspace runs a layout/command | `ui.newWorkspace.action` (C:S) | `default_session_mode`, `default_tab_config_path` | missing | yes: with launch layouts |
| Hide all sidebar details | `sidebar.hideAllDetails` (C:S) | none | partial: `sidebar.showPath/showMessage/showDescription/showExtensionItems` one by one | no: the per-item switches already cover it |
| Path: last segment only | `sidebar.pathLastSegmentOnly` (C:S) | none | missing | maybe: cheap |
| Notification message line limit | `sidebar.notificationMessageLineLimit` (C:S) | none | missing: one line | no |
| Pull request links / branch layout | `showPullRequests`, `branchLayout`, `makePullRequestsClickable` (C:S) | vertical tabs `show_pr_link`, `show_diff_stats` (W:/terminal/windows/vertical-tabs/) | partial: git branch + counts from the git extension; no PRs | maybe: a git extension setting (`gh` if present), not core |
| Compact agent status / badge position | `compactAgentStatus`, `notificationBadgePosition` (C:S) | vertical tabs `view_mode`, `compact_subtitle` | missing | no: one status vocabulary (PRODUCT.md principle 2) |
| Use latest prompt as workspace title | none | `use_latest_prompt_as_title` | partial: title follows the project; agents set a description | maybe |
| AI naming of workspaces | `automation.workspaceAutoNaming` (C:S) | none | missing | maybe: an assistant feature, off by default, only what the human put in (§4) |

## Notifications

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Long-command threshold | none | `long_running_threshold` (W:/terminal/more-features/notifications/) | partial: `commandFinished` on/off; threshold fixed in `shouldNotifyCommandEnd` | yes: one number |
| Sound choice / custom file / per-alert | `notifications.sound`, `customSoundFilePath`, `soundOverrides` (C:S) | `play_notification_sound` | partial: `notifications.sound` on/off, system sound only | maybe: waiting vs done sounds differ in value |
| Toast duration | none | `notifications.toast_duration_secs` | missing | no: OS banners own their timing |
| Pane ring / flash on/off and color | `unreadPaneRing`, `paneFlash`, `paneFlashColor` (C:S) | none | missing: always on | no: attention is the product's one loud signal (PRODUCT.md); reduced motion already calms it |
| Tray / dock unread badge | `notifications.dockBadge`, `showInMenuBar` (C:S) | none | missing: tray icon has no count | yes: with close-to-tray the badge is the only signal |
| Sound when focused / suppress rules | `soundWhenFocused`, `suppressOnlyFocusedSurface`, `suppressWhenAppFocused` (C:S) | none | partial: `notifications.whenFocused` | no: enough |
| Agent idle reminder | `agentIdleReminder` (C:S) | none | missing | maybe: a second nudge for a `waiting` agent after N minutes |
| Suppress subagent notifications | `automation.suppressSubagentNotifications` (C:S) | `orchestration_message_display_mode` | missing | maybe: manager workers could be muted per worker |
| Password prompt detected | `showPasswordInputIndicator` (C:S) | `is_password_prompt_enabled` | missing | maybe: sudo in a background pane waits forever unnoticed |
| Notification filter hooks | `notifications.hooks`, `hooksMode` (C:notifications) | none | partial: `notifications.command` runs a program per notification but can't filter | no: a filter chain is a shell pipeline over every signal; too much for the gain |

## Keyboard

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Default chords for pane work (split, focus by direction, close, zoom) | ⌘D, ⌘⇧D, ⌥⌘arrows, ⌘⇧↩ (C:SC) | Ctrl+Shift+D/E, Ctrl+Alt+arrows, Ctrl+Shift+Enter (W:/getting-started/keyboard-shortcuts/) | partial: `pane.split*`, `pane.zoom` are bindable palette commands without defaults; there's no directional focus command | yes: the biggest daily gap; defaults must pass `stealsTerminalKey` and avoid Monaco's chords (§4) |
| Tab / workspace next-previous, move | ⌃⌘]/[, ⌘⇧]/[ (C:SC) | Ctrl+PgUp/PgDn, Ctrl+Shift+Left/Right | partial: `workspace.goto` 1-9 only | yes: next/prev commands + defaults |
| Keyboard pane resize | ⌃⇧H/J/K/L (C:SC) | none | missing | maybe |
| Rename workspace/tab chord | ⌘⇧R, ⌘R (C:SC) | none | missing: menu only | maybe |
| Chord sequences (multi-key) | arrays in `shortcuts.bindings` (C:S) | none | missing | no: single chords are enough |
| `when` context clauses | `shortcuts.when` (C:S) | none | partial: terminal vs window chords are split in code | no: adds a small language; the terminal/window split covers the needs |
| Modifier-hold hints | `shortcuts.showModifierHoldHints` (C:S) | none | partial: workspace digits on a held modifier, no switch | no: it never flashes for other chords (§4) |

## Browser

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Search suggestions | `browser.showSearchSuggestions` (C:S) | none | missing | no: sends keystrokes to a search engine |
| Browser color scheme | `browser.theme` system/light/dark (C:S) | none | missing: follows the OS | maybe: `prefers-color-scheme` override per app theme |
| Discard hidden webviews | `discardHiddenWebViews`, `hiddenWebViewDiscardDelaySeconds` (C:S) | none | missing: hidden tabs stay mounted | no: unmounting reloads webviews (§4 tabs invariant) |
| Download location prompt | `browser.askWhereToSaveDownloads` (C:S) | none | missing | maybe |
| Hosts to open inside / outside | `hostsToOpenInEmbeddedBrowser`, `urlsToAlwaysOpenExternally` (C:S) | none | partial: `browser.openTerminalLinks` is all or nothing | maybe: localhost-only routing matches the ports chip use |
| URL allowlist / insecure http hosts | `urlAllowlist`, `insecureHttpHostsAllowedInEmbeddedBrowser` (C:S) | none | missing | maybe: for sandboxed workspaces, as sandbox policy in main |
| Intercept `open <url>` from the terminal | `interceptTerminalOpenCommandInCmuxBrowser` (C:S) | none | missing | maybe: `$BROWSER` pointing at `pine browse open` |
| Disable the browser | `browser.disabled`, policy `DisableEmbeddedBrowser` (C:K/Browser) | none | missing | no |

## Editor

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Indent guides, current-line highlight | `fileEditor.indentGuides`, `currentLineHighlight` (C:S) | none | missing: Monaco defaults | no: quick-edit surface, not IDE parity (PRODUCT.md goal 6) |
| Syntax highlighting on/off | `fileEditor.syntaxHighlighting` (C:S) | none | missing | no |
| Diff default layout | `diffViewer.defaultLayout` unified/split (C:S) | none | partial: side-by-side with an inline toggle per pane; no default | yes: one setting, frequently toggled |
| Markdown opens in preview | `openMarkdownInCmuxViewer` (C:S) | `prefer_markdown_viewer` (W:/terminal/more-features/markdown-viewer/) | partial: preview is a toggle; files open as source | yes: agent-written `.md` is read more than edited |
| File tree double-click action | `fileExplorer.doubleClickAction` (C:S) | none | missing | no |
| Default editor for files | `app.preferredEditor`, `openSupportedFilesInCmux` (C:S) | `open_file_editor`, `use_warp_as_default_editor` | partial: `behavior.externalEditor` for "Open in External Editor"; files open in Pine | maybe: "open files in the external editor by default" |

## Agents and AI

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Per-agent integration on/off | `automation.claudeCodeIntegration`, `codexIntegration`, ... (C:S) | third-party CLI agent toolbar `agents.third_party.*` (W:/agents/cli-agents/overview/) | missing: Claude/Codex hooks are always injected | yes: a user whose own hooks conflict needs an off switch per agent |
| More agent integrations | 7 built in + `cmux hooks setup` for 17 agents (C:agent-hooks) | Claude Code, Codex, OpenCode | partial: Claude Code and Codex hooks; others through `pine state` / OSC | maybe: add hooks recipes as data, per agent, in docs/AGENT-HOOKS.md |
| Auto "continue" after a retryable error | `automation.agentAutoResume` (C:S) | none | missing | no: types into a running pane without the human (§4) |
| Agent launch wrappers / custom resume argv | `agents.launchers`, `vault.agents` (C:S) | none | partial: `manager.agents` presets; `resumeCommand` knows claude/codex only | maybe: data-only resume templates, still `[A-Za-z0-9._-]` ids (§4) |
| Per-workspace port base | `automation.portBase`, `portRange` (C:S) | none | missing | maybe: `PINE_PORT` per workspace helps parallel dev servers |
| Voice input | none | `voice_input_enabled`, `voice_input_toggle_key` (W:/agents/local-agents/interacting-with-agents/voice/) | missing | maybe: local speech-to-text into the composer, never Enter |
| Rich input for CLI agents (auto-open composer) | TextBox (C:S) | `auto_open_composer_on_cli_agent_start`, `auto_dismiss_composer_after_submit` (W:/agents/cli-agents/rich-input/) | partial: composer opens on its chord only | maybe: an "open composer when an agent starts" switch |

## Privacy and security

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Secret redaction | none | see Blocks | missing | yes (see Blocks) |
| Socket control mode / password | `automation.socketControlMode`, `socketPassword` (C:configuration) | none | partial: per-pane token + capabilities; no mode switch | no: capabilities are finer than a mode |
| Managed policies (admin) | `Disable*` policy keys (docs site managed-policies) | Teams admin panel | missing | no: single-user tool |
| Auto-update | `app.installUpdatesAutomatically` (C:K/App) | changelog after update | missing: `pnpm install:local` | no: no update channel yet |

## Sync and misc

| Setting | cmux | Warp | Pine status | Worth adding? |
|---|---|---|---|---|
| Per-project settings file | `./.cmux/cmux.json` with trust prompt (docs site custom-commands) | `.warp/workflows`, `AGENTS.md` | partial: `.pine/workflows` only | maybe: project layouts and actions, behind a trust prompt like actions |
| Setting presets | `settingPresets`, `cmux config preset` (C:S) | none | missing | no: sync + actions cover it |
| Config packs | `packs` (C:S) | none | missing | no |
| Settings-set actions (toggle/cycle a setting from a button) | `actions` type `setting` (C:S) | none | partial: `actions` run palette commands; `settings.set` is a command | no: already expressible |
| Language count | 18 locales (C:S) | none | partial: en, zh-Hant | maybe: through the existing locale contribution |

## Pine has, they don't

- Agent capabilities and approvals (`capabilities.grants`, `approvals.mode`), with approval cards and a permission inbox.
- The manager: `manager.agents`, `skills`, `allowInput` and `limits`.
- Sandboxed workspaces (bwrap/Seatbelt) with domain, port, secret and package requests.
- Settings sync through a folder you own (`sync.dir`). cmux has none; Warp's is hosted.
- The phone gateway with per-device grants (Settings → Remote).
- User actions: palette commands as buttons and tab-menu entries, with trust.
- Declarative views that users enable one by one (Settings → Views).
- Saved browser passwords, kept encrypted in main.
- Extension settings and secrets (Settings → Extensions), plus VS Code file icon themes.
- A VS Code-style Files tree: `files.exclude`, nesting, compact folders, sort, icon theme.
- Language servers (Settings → Language servers).
- Separate UI, terminal and editor fonts, and terminal and editor color schemes unlinked from the app theme.
- `appearance.motion` (system / reduced / full).
- `terminal.clipboardKeys: 'smart'` and `warnOnRiskyPaste`.
- `workspaceGroups.byCwd` auto-grouping. cmux has the same.
- Assistant chat history kept only on this computer (`assistant.chatHistory`).

## Top 10 to add

1. **Default chords for pane work.** Split, focus by direction, close, zoom, next/previous tab and workspace. The commands exist but have no keys, and directional focus is missing entirely.
2. **Shell to launch.** A `terminal.shell` argv, spawned without a shell wrapper, falling back to `$SHELL`.
3. **Secret redaction.** Mask known token patterns plus user regexes in copies, selection reports and assistant context.
4. **OSC 52 clipboard.** Write allowed; reading asks first.
5. **Global show/hide hotkey and an unread badge on the tray icon.** These make close-to-tray usable.
6. **Launch layouts.** "New workspace from layout" from data files with folder, splits, env and a first command typed only at the first idle prompt.
7. **Per-agent hook switches.** Turn Pine's Claude Code / Codex hook injection off one agent at a time.
8. **Notification tuning.** A long-command threshold and a bell mode (attention / sound / off).
9. **Linux clipboard and macOS keys.** Middle-click paste / primary selection and Option-as-Meta.
10. **Input editor completion options.** Open completions while typing, a history autosuggestion switch, native shell completions (already on the roadmap), and markdown / diff defaults (preview first, unified or split).
