import { attach, Attach, NeovimClient } from '@chemzqm/neovim'
import {
  BufferId,
  ChangedTick,
  PreviewPayload,
  PreviewApp,
  PreviewPlugin
} from '../app-contract'

const logger = require('../util/logger')('attach')

let app: PreviewApp | undefined

interface VimBuffer {
  id: number
  name: string | Promise<string>
  getLines: (() => Promise<string[]>)
}

interface NotificationPayload {
  bufnr: BufferId
  data?: PreviewPayload
}

interface ResponseHandle {
  send: (() => void)
}

const asString = (value: unknown) => typeof value === 'string' ? value : ''

export default function(options: Attach): PreviewPlugin {
  const nvim: NeovimClient = attach(options)

  const findBuffer = async (bufnr: BufferId): Promise<VimBuffer | undefined> => {
    const buffers = await nvim.buffers
    return buffers.find(buffer => buffer.id === Number(bufnr)) as VimBuffer | undefined
  }

  const getChangedtick = async (bufnr: BufferId): Promise<ChangedTick> =>
    await nvim.call('getbufvar', [Number(bufnr), 'changedtick']) as ChangedTick

  const getScrollData = async (buffer: VimBuffer): Promise<PreviewPayload> => {
    const winline = await nvim.call('winline')
    const currentWindow = await nvim.window
    const winheight = await nvim.call('winheight', currentWindow.id)
    const cursor = await nvim.call('getpos', '.')
    const options = await nvim.getVar('mkdp_preview_options')
    const currentBuffer = await nvim.buffer
    return {
      options,
      isActive: currentBuffer.id === buffer.id,
      winline,
      winheight,
      cursor
    }
  }

  const resolveField = async <K extends keyof PreviewPayload>(
    data: PreviewPayload | undefined,
    key: K,
    fallback: (() => Promise<PreviewPayload[K]> | PreviewPayload[K])
  ): Promise<PreviewPayload[K]> =>
    data && data[key] !== undefined ? data[key] : fallback()

  const withLineCount = async (data: PreviewPayload): Promise<PreviewPayload> =>
    data && data.len !== undefined
      ? data
      : {
          ...data,
          len: await nvim.call('line', ['$'])
        }

  nvim.on('notification', async (method: string, args: unknown[]) => {
    const opts = (args[0] || {}) as NotificationPayload
    const bufnr = opts.bufnr
    const currentApp = app
    if (!currentApp) {
      logger.warn('drop notification before app init: ', method)
      return
    }
    if ((method === 'refresh_content' || method === 'sync_scroll') && !currentApp.hasClients({ bufnr })) {
      return
    }
    if (method === 'sync_scroll' && opts.data) {
      currentApp.syncScroll({
        bufnr,
        data: opts.data
      })
      return
    }
    if (method === 'refresh_content' || method === 'sync_scroll') {
      const buffer = await findBuffer(bufnr)
      if (!buffer) {
        return
      }
      const scrollData = opts.data || await getScrollData(buffer)
      if (method === 'sync_scroll') {
        currentApp.syncScroll({
          bufnr,
          data: await withLineCount(scrollData)
        })
        return
      }
      const changedtick = await resolveField(scrollData, 'changedtick', () => getChangedtick(bufnr))
      if (currentApp.isContentFresh({ bufnr, changedtick })) {
        currentApp.syncScroll({
          bufnr,
          data: await withLineCount(scrollData)
        })
        return
      }

      const pageTitle = await resolveField(scrollData, 'pageTitle', async () => asString(await nvim.getVar('mkdp_page_title')))
      const theme = await resolveField(scrollData, 'theme', async () => asString(await nvim.getVar('mkdp_theme')))
      const name = await resolveField(scrollData, 'name', () => buffer.name)
      const content = await buffer.getLines()
      currentApp.refreshPage({
        bufnr,
        data: {
          ...scrollData,
          pageTitle,
          theme,
          name,
          content,
          changedtick
        }
      })
    } else if (method === 'close_page') {
      currentApp.closePage({
        bufnr
      })
    } else if (method === 'open_browser') {
      currentApp.openBrowser({
        bufnr
      })
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

  nvim.channelId
    .then(async channelId => {
      await nvim.setVar('mkdp_node_channel_id', channelId)
    })
    .catch(e => {
      logger.error('channelId: ', e)
    })

  return {
    nvim,
    init: (param: PreviewApp) => {
      app = param
    }
  }
}
