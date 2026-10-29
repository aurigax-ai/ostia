import { afterEach, beforeEach } from 'vitest'
import { startConsoleGuard, stopConsoleGuard } from './consoleGuard'

beforeEach(startConsoleGuard)
afterEach(stopConsoleGuard)
