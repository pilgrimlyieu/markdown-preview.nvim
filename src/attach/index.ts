import { attach, Attach, NeovimClient } from '@chemzqm/neovim'
import { PreviewApp, PreviewPlugin } from '../app-contract'
import createLogger from '../util/logger'
import { dispatch, Notification } from './dispatch'

const logger = createLogger('attach')

let app: PreviewApp | undefined

interface ResponseHandle {
  send: (() => void)
}

export default function(options: Attach): PreviewPlugin {
  const nvim: NeovimClient = attach(options)

  nvim.on('notification', (method: string, args: unknown[]) => {
    const result = dispatch(app, method, (args[0] || {}) as Notification)
    if (result === 'dropped-before-init' || result === 'dropped-without-data') {
      logger.warn(`${result}: `, method)
    }
  })

  nvim.on('request', (method: string, args: unknown, resp: ResponseHandle) => {
    if (method === 'close_all_pages') {
      const currentApp = app
      if (currentApp) {
        currentApp.closeAllPages()
      }
    }
    resp.send()
  })

  return {
    nvim,
    init: (param: PreviewApp) => {
      app = param
    }
  }
}
