import { ChildProcess } from 'child_process'
import http from 'http'
import net, { AddressInfo } from 'net'
import { URL } from 'url'

import {
  BufferId,
  ChangedTick,
  ContentTickEvent,
  PageEvent,
  PreviewPayload
} from './app-contract'
import { plugin } from './nvim'
import routes, { PreviewRequest } from './routes'
import { getIP } from './util/getIP'

const WebSocket = require('ws') as WebSocketModule
const opener = require('./util/opener') as ((url: string, browser?: string) => ChildProcess)
const logger = require('./util/logger')('app/server')

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
type ContentTickMap = { [bufnr: string]: string | undefined }

const MSG_PREFIX = '[markdown-preview.nvim]'

export function run() {
  let clients: ClientMap = {}
  let contentTicks: ContentTickMap = {}
  let nextClientId = 1
  const startBufnr = Number(process.env.MKDP_START_BUFNR) || 0

  const clientKey = (bufnr: BufferId) => String(bufnr)

  const openUrl = (url: string, browser?: string) => {
    const handler = opener(url, browser)
    handler.on('error', (err: Error) => {
      const message = err.message || ''
      const match = message.match(/\s*spawn\s+(.+)\s+ENOENT\s*/)
      if (match) {
        plugin.nvim.call('mkdp#util#echo_messages', ['Error', [`${MSG_PREFIX}: Can not open browser by using ${match[1]} command`]])
      } else {
        plugin.nvim.call('mkdp#util#echo_messages', ['Error', [err.name, err.message]])
      }
    })
  }

  const connectedClients = (bufnr: BufferId) =>
    (clients[clientKey(bufnr)] || []).filter(client => client.readyState === WebSocket.OPEN)

  const normalizeTick = (changedtick: ChangedTick) =>
    changedtick === undefined || changedtick === null ? '' : String(changedtick)

  const markContentFresh = ({ bufnr, changedtick }: ContentTickEvent) => {
    const tick = normalizeTick(changedtick)
    if (tick) {
      contentTicks[clientKey(bufnr)] = tick
    }
  }

  const clearContentFresh = (bufnr: BufferId) => {
    delete contentTicks[clientKey(bufnr)]
  }

  const isContentFresh = ({ bufnr, changedtick }: ContentTickEvent) =>
    contentTicks[clientKey(bufnr)] === normalizeTick(changedtick)

  const hasConnectedClients = () =>
    Object.keys(clients).some(bufnr => connectedClients(bufnr).length > 0)

  const hasClients = ({ bufnr }: { bufnr: BufferId }) => {
    clients[clientKey(bufnr)] = connectedClients(bufnr)
    return connectedClients(bufnr).length > 0
  }

  const forEachConnectedClient = (bufnr: BufferId, callback: ((client: PreviewClient) => void)) => {
    clients[clientKey(bufnr)] = connectedClients(bufnr)
    connectedClients(bufnr).forEach(callback)
  }

  const sendToClient = (client: PreviewClient, event: string, data: unknown) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }))
    }
  }

  const emitToClients = (bufnr: BufferId, event: string, data: unknown) => {
    forEachConnectedClient(bufnr, client => {
      sendToClient(client, event, data)
    })
  }

  const closeClients = (bufnr: BufferId) => {
    emitToClients(bufnr, 'close_page', undefined)
    connectedClients(bufnr).forEach(client => client.close())
    delete clients[clientKey(bufnr)]
    clearContentFresh(bufnr)
  }

  const updateClientsActiveVar = () => {
    plugin.nvim
      .setVar('mkdp_clients_active', hasConnectedClients() ? 1 : 0)
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

    clients[clientKey(bufnr)] = clients[clientKey(bufnr)] || []
    clients[clientKey(bufnr)]!.push(client)
    updateClientsActiveVar()

    try {
      const initialData = await plugin.nvim.call('mkdp#rpc#preview_data', [Number(bufnr), 1]) as PreviewPayload
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
      clients[clientKey(bufnr)] = connectedClients(bufnr).filter(c => c.id !== client.id)
      if (clients[clientKey(bufnr)]!.length === 0) {
        delete clients[clientKey(bufnr)]
      }
      updateClientsActiveVar()
    })
  })

  async function startServer() {
    const openToTheWord = await plugin.nvim.getVar('mkdp_open_to_the_world')
    const host = openToTheWord ? '0.0.0.0' : '127.0.0.1'
    const preferredPort = normalizePort(await plugin.nvim.getVar('mkdp_port'))
    const startPort = preferredPort || (8080 + Number(`${Date.now()}`.slice(-3)))
    const portRange = await plugin.nvim.getVar('mkdp_port_range')
    const port = await listenOnAvailablePort({
      host,
      startPort,
      portRange
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
      const combinePreview = await plugin.nvim.getVar('mkdp_combine_preview')
      if (combinePreview && hasConnectedClients()) {
        logger.info(`combine preview page: `, bufnr)
        Object.keys(clients).forEach(clientBufnr => {
          forEachConnectedClient(clientBufnr, client => {
            sendToClient(client, 'change_bufnr', bufnr)
          })
        })
      } else {
        const openIpValue = await plugin.nvim.getVar('mkdp_open_ip')
        const openIp = typeof openIpValue === 'string' ? openIpValue : ''
        const openHost = openIp !== '' ? openIp : (openToTheWord ? getIP() : 'localhost')
        const url = `http://${openHost}:${port}/page/${bufnr}`
        const browserfuncValue = await plugin.nvim.getVar('mkdp_browserfunc')
        const browserfunc = typeof browserfuncValue === 'string' ? browserfuncValue : ''
        if (browserfunc !== '') {
          logger.info(`open page [${browserfunc}]: `, url)
          plugin.nvim.call(browserfunc, [url])
        } else {
          const browserValue = await plugin.nvim.getVar('mkdp_browser')
          const browser = typeof browserValue === 'string' ? browserValue : ''
          logger.info(`open page [${browser || 'default'}]: `, url)
          if (browser !== '') {
            openUrl(url, browser)
          } else {
            openUrl(url)
          }
        }
        const isEchoUrl = await plugin.nvim.getVar('mkdp_echo_preview_url')
        if (isEchoUrl) {
          plugin.nvim.call('mkdp#util#echo_url', [url])
        }
      }
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

    if (startBufnr > 0) {
      plugin.nvim.call('mkdp#util#open_browser', [startBufnr])
    } else {
      plugin.nvim.call('mkdp#util#open_browser')
    }
  }

  startServer().catch((err: Error) => {
    logger.error('start server failed: ', err)
    plugin.nvim.call('mkdp#util#echo_messages', ['Error', [`${MSG_PREFIX} failed to start`, `${err}`]])
  })
}
