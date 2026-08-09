import http from 'http'
import net, { AddressInfo } from 'net'
import { URL } from 'url'

import {
  BufferId,
  ChangedTick,
  ContentTickEvent,
  PageEvent
} from './app-contract'
import { getConfig } from './config'
import { plugin } from './nvim'
import { echoError, openUrl, previewPayload } from './rpc'
import routes, { PreviewRequest } from './routes'
import { getIP } from './util/getIP'
import createLogger from './util/logger'

const WebSocket = require('ws') as WebSocketModule
const logger = createLogger('app/server')

interface PreviewClient {
  id?: number
  readyState: number
  send: ((data: string) => void)
  close: (() => void)
  on: ((event: 'close', callback: (() => void)) => void)
}

interface WebSocketServer {
  on: ((event: 'connection', callback: ((client: PreviewClient, req: http.IncomingMessage) => void)) => void)
}

interface WebSocketModule {
  OPEN: number
  Server: new (options: { server: http.Server, path: string }) => WebSocketServer
}

interface ListenOptions {
  host: string
  port: number
}

type ClientMap = { [bufnr: string]: PreviewClient[] | undefined }
type ContentTickMap = { [bufnr: string]: ChangedTick }

export function run() {
  let clients: ClientMap = {}
  let contentTicks: ContentTickMap = {}
  let nextClientId = 1
  const startBufnr = Number(process.env.MKDP_START_BUFNR) || 0

  const clientKey = (bufnr: BufferId) => String(bufnr)

  /** Live clients for a buffer, pruning any socket that died without closing. */
  const liveClients = (bufnr: BufferId) => {
    const key = clientKey(bufnr)
    const live = (clients[key] || []).filter(client => client.readyState === WebSocket.OPEN)
    if (live.length) {
      clients[key] = live
    } else {
      delete clients[key]
    }
    return live
  }

  const markContentFresh = ({ bufnr, changedtick }: ContentTickEvent) => {
    if (changedtick !== undefined) {
      contentTicks[clientKey(bufnr)] = changedtick
    }
  }

  const isContentFresh = ({ bufnr, changedtick }: ContentTickEvent) =>
    changedtick !== undefined && contentTicks[clientKey(bufnr)] === changedtick

  const hasConnectedClients = () =>
    Object.keys(clients).some(bufnr => liveClients(bufnr).length > 0)

  const hasClients = ({ bufnr }: { bufnr: BufferId }) => liveClients(bufnr).length > 0

  const sendToClient = (client: PreviewClient, event: string, data: unknown) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }))
    }
  }

  const emitToClients = (bufnr: BufferId, event: string, data: unknown) => {
    liveClients(bufnr).forEach(client => sendToClient(client, event, data))
  }

  const closeClients = (bufnr: BufferId) => {
    emitToClients(bufnr, 'close_page', undefined)
    liveClients(bufnr).forEach(client => client.close())
    delete clients[clientKey(bufnr)]
    delete contentTicks[clientKey(bufnr)]
  }

  const updateClientsActiveVar = () => {
    plugin.nvim
      .setVar('mkdp_clients_active', hasConnectedClients())
      .catch((err: Error) => {
        logger.warn('failed to update clients active var: ', err)
      })
  }

  const normalizePort = (port: unknown) => {
    const value = Number(port)
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0
  }

  const normalizePortRange = (range: unknown, startPort: number) => {
    const value = Number(range)
    if (!Number.isInteger(value) || value < 1) {
      return 1
    }
    return Math.min(value, 65535 - startPort + 1)
  }

  const isPortUnavailableError = (err: unknown) => {
    const code = typeof err === 'object' && err && 'code' in err
      ? String((err as { code?: unknown }).code)
      : ''
    if (['EADDRINUSE', 'EACCES'].includes(code)) {
      return true
    }
    // Bun reports a busy port as "Failed to start server. Is port N in use?",
    // sometimes without a `code`.
    const message = err instanceof Error ? err.message : String(err || '')
    return /(EADDRINUSE|EACCES|port \d+ .*in use)/i.test(message)
  }

  const server = http.createServer((req, res) => {
    const previewReq = req as PreviewRequest
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : ''
    const source = referer || req.url || ''
    previewReq.plugin = plugin
    previewReq.bufnr = source.replace(/[?#].*$/, '').split('/').pop() || ''
    previewReq.asPath = (req.url || '').replace(/[?#].*$/, '')
    routes(previewReq, res)
  })

  // Probe with a throwaway socket first. Binding the real http.Server to a busy
  // port can escape as an uncaughtException under Bun instead of rejecting,
  // which kills the port fallback below. A plain net.Server fails cleanly.
  const checkPortAvailable = ({ host, port }: ListenOptions) => new Promise<void>((resolve, reject) => {
    const probe = net.createServer()
    const cleanup = () => {
      probe.removeListener('error', onError)
      probe.removeListener('listening', onListening)
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onListening = () => {
      cleanup()
      probe.close((err?: Error) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    }

    probe.once('error', onError)
    probe.once('listening', onListening)
    try {
      probe.listen({ host, port })
    } catch (err) {
      cleanup()
      reject(err)
    }
  })

  const listen = async ({ host, port }: ListenOptions) => {
    await checkPortAvailable({ host, port })
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('server did not expose a TCP port'))
          return
        }
        resolve((address as AddressInfo).port)
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host, port })
    })
  }

  const listenOnAvailablePort = async ({ host, startPort, portRange }: {
    host: string,
    startPort: number,
    portRange: unknown
  }) => {
    let lastError: unknown = null
    const attempts = normalizePortRange(portRange, startPort)
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = startPort + offset
      try {
        return await listen({ host, port })
      } catch (err) {
        lastError = err
        if (!isPortUnavailableError(err)) {
          throw err
        }
        logger.warn(`port ${port} unavailable, trying next port`)
      }
    }
    throw lastError
  }

  const websocketServer = new WebSocket.Server({
    server,
    path: '/ws'
  })

  websocketServer.on('connection', async (client, req) => {
    const params = new URL(req.url || '', 'http://localhost').searchParams
    const bufnr = params.get('bufnr')
    client.id = nextClientId
    nextClientId += 1

    if (!bufnr) {
      client.close()
      return
    }

    logger.info('client connect: ', client.id, bufnr)

    const key = clientKey(bufnr)
    clients[key] = (clients[key] || []).concat(client)
    updateClientsActiveVar()

    try {
      const initialData = await previewPayload(plugin.nvim, bufnr, true)
      if (initialData && initialData.content) {
        sendToClient(client, 'refresh_content', initialData)
        markContentFresh({ bufnr, changedtick: initialData.changedtick })
      }
    } catch (err) {
      logger.error('initial content load failed: ', err)
      client.close()
    }

    client.on('close', () => {
      logger.info('disconnect: ', client.id)
      const remaining = liveClients(bufnr).filter(other => other.id !== client.id)
      if (remaining.length) {
        clients[key] = remaining
      } else {
        delete clients[key]
      }
      updateClientsActiveVar()
    })
  })

  async function startServer() {
    const { server: serverConfig = {} } = await getConfig(plugin.nvim)
    const openToTheWord = Boolean(serverConfig.open_to_the_world)
    const host = openToTheWord ? '0.0.0.0' : '127.0.0.1'
    const preferredPort = normalizePort(serverConfig.port)
    const startPort = preferredPort || (8080 + Number(`${Date.now()}`.slice(-3)))
    const port = await listenOnAvailablePort({
      host,
      startPort,
      portRange: serverConfig.port_range
    })
    logger.info('server run: ', port)

    const refreshPage = ({ bufnr, data }: PageEvent) => {
      logger.debug('refresh page: ', bufnr)
      markContentFresh({ bufnr, changedtick: data.changedtick })
      emitToClients(bufnr, 'refresh_content', data)
    }

    const syncScroll = ({ bufnr, data }: PageEvent) => {
      logger.debug('sync scroll: ', bufnr)
      emitToClients(bufnr, 'sync_scroll', data)
    }

    const closePage = ({ bufnr }: { bufnr: BufferId }) => {
      logger.info('close page: ', bufnr)
      closeClients(bufnr)
    }

    const closeAllPages = () => {
      logger.info('close all pages')
      Object.keys(clients).forEach(closeClients)
      clients = {}
      contentTicks = {}
    }

    const openBrowser = async ({ bufnr }: { bufnr: BufferId }) => {
      const config = await getConfig(plugin.nvim)
      if (config.combine?.enabled && hasConnectedClients()) {
        logger.info(`combine preview page: `, bufnr)
        Object.keys(clients).forEach(clientBufnr => {
          emitToClients(clientBufnr, 'change_bufnr', bufnr)
        })
        return
      }

      const openIp = config.server?.open_ip || ''
      const openHost = openIp || (openToTheWord ? getIP() : 'localhost')
      const url = `http://${openHost}:${port}/page/${bufnr}`
      logger.info('open page: ', url)
      // The editor owns the browser, so `config.browser` can be a Lua function.
      await openUrl(plugin.nvim, url)
    }

    plugin.init({
      refreshPage,
      closePage,
      closeAllPages,
      syncScroll,
      hasClients,
      isContentFresh,
      openBrowser
    })

    await openBrowser({ bufnr: startBufnr })
  }

  startServer().catch((err: Error) => {
    logger.error('start server failed: ', err)
    echoError(plugin.nvim, ['the preview server failed to start', `${err}`])
  })
}
