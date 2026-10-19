import { join } from 'node:path'
import { decodersIn } from '../../../src/extensions/archives/decoders'

export const archiveDecoders = decodersIn(join(__dirname, '../../../out/extensions/archives'))
