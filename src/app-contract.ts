import { NeovimClient } from '@chemzqm/neovim'

export type BufferId = number | string
export type ChangedTick = number | string | null | undefined

export interface BufferEvent {
  bufnr: BufferId
}

export interface PageEvent<T = PreviewPayload> extends BufferEvent {
  data: T
}

export interface ContentTickEvent extends BufferEvent {
  changedtick: ChangedTick
}

export interface PreviewPayload {
  options?: unknown
  isActive?: boolean
  winline?: number
  winheight?: number
  cursor?: unknown
  len?: number
  pageTitle?: string
  theme?: string
  name?: string
  content?: string[]
  changedtick?: ChangedTick
}

export interface PreviewApp {
  refreshPage: ((param: PageEvent) => void)
  closePage: ((params: BufferEvent) => void)
  closeAllPages: (() => void)
  syncScroll: ((param: PageEvent) => void)
  hasClients: ((params: BufferEvent) => boolean)
  isContentFresh: ((params: ContentTickEvent) => boolean)
  openBrowser: ((params: BufferEvent) => void)
}

export interface PreviewPlugin {
  init: ((app: PreviewApp) => void)
  nvim: NeovimClient
}
