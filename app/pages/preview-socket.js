const reconnectDelay = 500

function socketUrl (bufnr) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws?bufnr=${encodeURIComponent(bufnr)}`
}

export default function createPreviewSocket (bufnr) {
  const handlers = {}
  let socket = null
  let closed = false
  let reconnectTimer = null

  const emit = (event, data) => {
    const eventHandlers = handlers[event] || []
    eventHandlers.forEach((handler) => handler(data))
  }

  const connect = () => {
    reconnectTimer = null
    const nextSocket = new WebSocket(socketUrl(bufnr))
    socket = nextSocket

    nextSocket.onopen = () => {
      emit('connect')
    }
    nextSocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message && message.event) {
          emit(message.event, message.data)
        }
      } catch (e) {
        console.error(e)
      }
    }
    nextSocket.onerror = () => {
      nextSocket.close()
    }
    nextSocket.onclose = () => {
      if (socket !== nextSocket) {
        return
      }
      socket = null
      emit('disconnect')
      if (!closed) {
        reconnectTimer = setTimeout(connect, reconnectDelay)
      }
    }
  }

  connect()

  return {
    on: (event, handler) => {
      handlers[event] = handlers[event] || []
      handlers[event].push(handler)
    },
    close: () => {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (socket) {
        socket.close()
      }
    }
  }
}
