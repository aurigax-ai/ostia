import { isolatedLaunch } from '../dataHome'
import { _electron as electron, expect, test } from '../test'

test('fails on purpose after its app has quit', async () => {
  const app = await electron.launch(isolatedLaunch())
  await app.firstWindow()
  await app.close()
  expect(app.windows()).toHaveLength(1)
})
