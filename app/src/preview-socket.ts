import type { PreviewSocket } from './types'

const reconnectDelay = 500

function socketUrl (bufnr: number) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws?bufnr=${encodeURIComponent(bufnr)}`
}

export default function createPreviewSocket (bufnr: number): PreviewSocket {
  const handlers = new Map<string, Array<(data?: unknown) => void>>()
  let socket: WebSocket | null = null
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: string, data?: unknown) => {
    const eventHandlers = handlers.get(event) || []
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
        if (message && typeof message.event === 'string') {
          emit(message.event, message.data as unknown)
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
      const eventHandlers = handlers.get(event) || []
      eventHandlers.push(handler)
      handlers.set(event, eventHandlers)
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
