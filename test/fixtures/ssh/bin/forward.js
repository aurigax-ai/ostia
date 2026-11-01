const net = require('node:net')
const [bind, localPort, targetHost, targetPort] = process.argv[2].split(':')
const server = net.createServer((client) => {
  const upstream = net.connect(Number(targetPort), targetHost)
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
})
server.on('error', () => process.exit(255))
server.listen(Number(localPort), bind, () => {
  if (process.argv[3]) require('node:fs').writeFileSync(process.argv[3], '')
})
process.on('SIGTERM', () => process.exit(0))
