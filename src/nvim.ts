import attach from './attach'
import { PreviewPlugin } from './app-contract'
import { echoError } from './rpc'
import createLogger from './util/logger'

const logger = createLogger('app/nvim')

export const plugin: PreviewPlugin = attach({
  reader: process.stdin,
  writer: process.stdout
})

process.on('uncaughtException', (err: Error) => {
  if (plugin.nvim) {
    echoError(plugin.nvim, ['uncaught exception', `${err.stack}`])
  }
  logger.error('uncaughtException', err.stack)
})

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  if (plugin.nvim) {
    echoError(plugin.nvim, ['unhandled rejection', `${reason}`])
  }
  logger.error('unhandledRejection ', promise, reason)
})
