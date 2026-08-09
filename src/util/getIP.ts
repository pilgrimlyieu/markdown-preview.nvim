import os from 'os'

/** First non-loopback IPv4 address, for `server.open_to_the_world`. */
export function getIP(): string {
  const addresses = Object.values(os.networkInterfaces()).flatMap(iface => iface || [])
  const external = addresses.find(alias =>
    alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1')
  return external ? external.address : ''
}
