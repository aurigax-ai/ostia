import { connect } from '@aurigax-ai/ostia-extension-sdk'
import { decodersIn } from './decoders'
import { sevenZip } from './sevenZip'
import { tarProvider } from './tar'
import { zip } from './zip'

const tar = tarProvider(decodersIn(__dirname))

void connect().then((ext) => {
  ext.onBrowse('zip', zip)
  ext.onBrowse('tar', tar)
  ext.onBrowse('tar-xz', tar)
  ext.onBrowse('tar-bz2', tar)
  ext.onBrowse('sevenzip', sevenZip)
})
