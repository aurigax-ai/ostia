import { connect } from '@aurigax-ai/ostia-extension-sdk'
import { tar } from './tar'
import { zip } from './zip'

void connect().then((ext) => {
  ext.onBrowse('zip', zip)
  ext.onBrowse('tar', tar)
})
