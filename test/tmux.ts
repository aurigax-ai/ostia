import { programPath } from '../src/main/systemRequirements'

export const tmuxPath = programPath('tmux')

export const skipWithoutTmux = tmuxPath === null && !process.env.CI
