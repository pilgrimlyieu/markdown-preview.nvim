exports.run = function () {
  // attach nvim
  const { plugin } = require('./nvim')
  const http = require('http')
  const net = require('net')
  const websocket = require('socket.io')

  const opener = require('./lib/util/opener')
  const logger = require('./lib/util/logger')('app/server')
  const { getIP } = require('./lib/util/getIP')
  const routes = require('./routes')

  let clients = {}
  const startBufnr = Number(process.env.MKDP_START_BUFNR) || 0

  const openUrl = (url, browser) => {
    const handler = opener(url, browser)
    handler.on('error', (err) => {
      const message = err.message || ''
      const match = message.match(/\s*spawn\s+(.+)\s+ENOENT\s*/)
      if (match) {
        plugin.nvim.call('mkdp#util#echo_messages', ['Error', [`[markdown-preview.nvim]: Can not open browser by using ${match[1]} command`]])
      } else {
        plugin.nvim.call('mkdp#util#echo_messages', ['Error', [err.name, err.message]])
      }
    })
  }

  const connectedClients = (bufnr) =>
    (clients[bufnr] || []).filter(client => client.connected)

  const hasConnectedClients = () =>
    Object.keys(clients).some(bufnr => connectedClients(bufnr).length > 0)

  const forEachConnectedClient = (bufnr, callback) => {
    clients[bufnr] = connectedClients(bufnr)
    clients[bufnr].forEach(callback)
  }

  const emitToClients = (bufnr, event, data) => {
    forEachConnectedClient(bufnr, client => {
      client.emit(event, data)
    })
  }

  const closeClients = (bufnr) => {
    emitToClients(bufnr, 'close_page')
    delete clients[bufnr]
  }

  const update_clients_active_var = () => {
    plugin.nvim.setVar('mkdp_clients_active', hasConnectedClients() ? 1 : 0)
  }

  const normalizePort = (port) => {
    const value = Number(port)
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0
  }

  const normalizePortRange = (range, startPort) => {
    const value = Number(range)
    if (!Number.isInteger(value) || value < 1) {
      return 1
    }
    return Math.min(value, 65535 - startPort + 1)
  }

  const isPortUnavailableError = (err) => {
    if (['EADDRINUSE', 'EACCES'].includes(err && err.code)) {
      return true
    }
    const message = String((err && err.message) || err || '')
    return /(EADDRINUSE|EACCES|port \d+ .*in use)/i.test(message)
  }

  const checkPortAvailable = ({ host, port }) => new Promise((resolve, reject) => {
    const probe = net.createServer()
    const cleanup = () => {
      probe.removeListener('error', onError)
      probe.removeListener('listening', onListening)
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onListening = () => {
      cleanup()
      probe.close((err) => {
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

  const listen = async ({ host, port }) => {
    await checkPortAvailable({ host, port })
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve(server.address().port)
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host, port })
    })
  }

  const listenOnAvailablePort = async ({ host, startPort, portRange }) => {
    let lastError = null
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

  // http server
  const server = http.createServer(async (req, res) => {
    // plugin
    req.plugin = plugin
    // bufnr
    req.bufnr = (req.headers.referer || req.url)
      .replace(/[?#].*$/, '').split('/').pop()
    // request path
    req.asPath = req.url.replace(/[?#].*$/, '')
    req.mkcss = await plugin.nvim.getVar('mkdp_markdown_css')
    req.hicss = await plugin.nvim.getVar('mkdp_highlight_css')
    req.custImgPath = await plugin.nvim.getVar('mkdp_images_path')
    // routes
    routes(req, res)
  })

  // websocket server
  const io = websocket(server)

  io.on('connection', async (client) => {
    const { handshake = { query: {} } } = client
    const bufnr = handshake.query.bufnr

    logger.info('client connect: ', client.id, bufnr)

    clients[bufnr] = clients[bufnr] || []
    clients[bufnr].push(client)
    // update vim variable
    update_clients_active_var();

    const buffers = await plugin.nvim.buffers
    buffers.forEach(async (buffer) => {
      if (buffer.id === Number(bufnr)) {
        const winline = await plugin.nvim.call('winline')
        const currentWindow = await plugin.nvim.window
        const winheight = await plugin.nvim.call('winheight', currentWindow.id)
        const cursor = await plugin.nvim.call('getpos', '.')
        const options = await plugin.nvim.getVar('mkdp_preview_options')
        const pageTitle = await plugin.nvim.getVar('mkdp_page_title')
        const theme = await plugin.nvim.getVar('mkdp_theme')
        const name = await buffer.name
        const content = await buffer.getLines()
        const currentBuffer = await plugin.nvim.buffer
        client.emit('refresh_content', {
          options,
          isActive: currentBuffer.id === buffer.id,
          winline,
          winheight,
          cursor,
          pageTitle,
          theme,
          name,
          content
        })
      }
    })

    client.on('disconnect', function () {
      logger.info('disconnect: ', client.id)
      clients[bufnr] = (clients[bufnr] || []).filter(c => c.id !== client.id)
      if (clients[bufnr].length === 0) {
        delete clients[bufnr]
      }
      // update vim variable
      update_clients_active_var();
    })
  })

  async function startServer () {
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
    function refreshPage ({ bufnr, data }) {
      logger.info('refresh page: ', bufnr)
      emitToClients(bufnr, 'refresh_content', data)
    }
    function closePage ({ bufnr }) {
      logger.info('close page: ', bufnr)
      closeClients(bufnr)
    }
    function closeAllPages () {
      logger.info('close all pages')
      Object.keys(clients).forEach(closeClients)
      clients = {}
    }
    async function openBrowser ({ bufnr }) {
      const combinePreview = await plugin.nvim.getVar('mkdp_combine_preview')
      if (combinePreview && hasConnectedClients()) {
        logger.info(`combine preview page: `, bufnr)
        Object.keys(clients).forEach(clientBufnr => {
          forEachConnectedClient(clientBufnr, client => {
            client.emit('change_bufnr', bufnr)
          })
        })
      } else {
        const openIp = await plugin.nvim.getVar('mkdp_open_ip')
        const openHost = openIp !== '' ? openIp : (openToTheWord ? getIP() : 'localhost')
        const url = `http://${openHost}:${port}/page/${bufnr}`
        const browserfunc = await plugin.nvim.getVar('mkdp_browserfunc')
        if (browserfunc !== '') {
          logger.info(`open page [${browserfunc}]: `, url)
          plugin.nvim.call(browserfunc, [url])
        } else {
          const browser = await plugin.nvim.getVar('mkdp_browser')
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
      openBrowser
    })

    if (startBufnr > 0) {
      plugin.nvim.call('mkdp#util#open_browser', [startBufnr])
    } else {
      plugin.nvim.call('mkdp#util#open_browser')
    }
  }

  startServer()
}
