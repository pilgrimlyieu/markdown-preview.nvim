import { attach, Attach, NeovimClient } from '@chemzqm/neovim'

const logger = require('../util/logger')('attach') // tslint:disable-line

interface IPageEvent {
  bufnr: number | string
  data: any
}

interface IBufferEvent {
  bufnr: number | string
}

interface IContentTickEvent extends IBufferEvent {
  changedtick: number | string
}

interface IApp {
  refreshPage: ((param: IPageEvent) => void)
  closePage: ((params: IBufferEvent) => void)
  closeAllPages: (() => void)
  syncScroll: ((param: IPageEvent) => void)
  hasClients: ((params: IBufferEvent) => boolean)
  isContentFresh: ((params: IContentTickEvent) => boolean)
  openBrowser: ((params: IBufferEvent) => void)
}

interface IPlugin {
  init: ((app: IApp) => void)
  nvim: NeovimClient
}

let app: IApp | undefined

export default function(options: Attach): IPlugin {
  const nvim: NeovimClient = attach(options)

  const findBuffer = async (bufnr: number | string) => {
    const buffers = await nvim.buffers
    return buffers.find(buffer => buffer.id === Number(bufnr))
  }

  const getChangedtick = (bufnr: number | string) =>
    nvim.call('getbufvar', [Number(bufnr), 'changedtick'])

  const getScrollData = async (buffer: any) => {
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

  const resolveField = async (data: any, key: string, fallback: (() => Promise<any>)) =>
    data && data[key] !== undefined ? data[key] : fallback()

  const withLineCount = async (data: any) =>
    data && data.len !== undefined
      ? data
      : {
          ...data,
          len: await nvim.call('line', ['$'])
        }

  nvim.on('notification', async (method: string, args: any[]) => {
    const opts = args[0] || args
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

      const pageTitle = await resolveField(scrollData, 'pageTitle', () => nvim.getVar('mkdp_page_title'))
      const theme = await resolveField(scrollData, 'theme', () => nvim.getVar('mkdp_theme'))
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

  nvim.on('request', (method: string, args: any, resp: any) => {
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
    init: (param: IApp) => {
      app = param
    }
  }
}
