export const TMUX_HISTORY_LIMIT = 20000

export function tmuxConf(defaultTerminal: string): string {
  return [
    'set -g prefix None',
    'set -g prefix2 None',
    'unbind-key -a',
    'unbind-key -a -T root',
    'unbind-key -a -T copy-mode',
    'unbind-key -a -T copy-mode-vi',
    'set -g status off',
    'set -g mouse off',
    'set -g allow-passthrough on',
    'set -g set-clipboard off',
    `set -g default-terminal "${defaultTerminal}"`,
    `set -g history-limit ${TMUX_HISTORY_LIMIT}`,
    'set -g remain-on-exit on',
    'set -g automatic-rename off',
    'set -g allow-rename off',
    'set -g escape-time 0',
    'set -g focus-events on',
    'set -g update-environment ""',
    'set -g destroy-unattached off',
    'set -g detach-on-destroy off',
    'set -g exit-empty off',
    'set -g visual-bell off',
    'set -g bell-action none',
    '',
  ].join('\n')
}
