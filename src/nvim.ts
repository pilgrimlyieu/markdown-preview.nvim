import attach from './attach'
import { PreviewPlugin } from './app-contract'

const logger = require('./util/logger')('app/nvim')

const MSG_PREFIX = '[markdown-preview.nvim]'

export const plugin: PreviewPlugin = attach({
  reader: process.stdin,
  writer: process.stdout
})

process.on('uncaughtException', (err: Error) => {
  const msg = `${MSG_PREFIX} uncaught exception: ${err.stack}`
  if (plugin.nvim) {
    plugin.nvim.call('mkdp#util#echo_messages', ['Error', msg.split('\n')])
  }
  logger.error('uncaughtException', err.stack)
})

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  if (plugin.nvim) {
    plugin.nvim.call('mkdp#util#echo_messages', ['Error', [`${MSG_PREFIX} UnhandledRejection`, `${reason}`]])
  }
  logger.error('unhandledRejection ', promise, reason)
})
