import { prepareLinks } from './links'
import type { PreviewPayload } from './types'
import { ordinaryClick } from './utils'

interface Position { left: number, top: number }
interface Restoration { hash: string, position: Position | null, fallbackToTop: boolean }
interface HistoryState { mkdpEntry?: string, mkdpScroll?: Position }
type NavigationMode = 'initial' | 'push' | 'pop' | 'replace' | 'refresh'

export interface PreviewLocation {
  bufnr: number
  path: string | null
  fileView: boolean
  sourceName: string
}

interface NavigationCallbacks {
  connect: (bufnr: number) => void
  render: (payload: PreviewPayload, newDocument: boolean, image?: HTMLImageElement) => void
  location?: (location: PreviewLocation) => void
}

/** Browser reading has its own document and history; the editor stays connected. */
export class PreviewNavigation {
  private bufnr = 0
  private documentPath: string | null = new URL(window.location.href).searchParams.get('path')
  private fileView = new URL(window.location.href).searchParams.get('view') === 'file'
  private locationKey = ''
  private source: PreviewPayload | null = null
  private request: AbortController | null = null
  private restoration: Restoration | null = null
  private restoreFrame: number | null = null
  private keepViewport = false
  private rendered = false
  private entry = ''
  private nextEntry = 0
  private displayedUrl = window.location.href
  private readonly positions = new Map<string, Position>()
  private readonly lifetime = new AbortController()
  private readonly contentObserver: MutationObserver
  private readonly notice = document.createElement('div')
  private readonly noticeText = document.createElement('span')

  constructor(private readonly content: HTMLElement, private readonly callbacks: NavigationCallbacks) {
    const signal = this.lifetime.signal
    this.notice.id = 'preview-message'
    this.notice.setAttribute('role', 'alert')
    this.notice.hidden = true
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = '×'
    dismiss.setAttribute('aria-label', 'Dismiss message')
    dismiss.addEventListener('click', () => { this.notice.hidden = true }, { signal })
    this.notice.append(this.noticeText, dismiss)
    content.before(this.notice)

    window.history.scrollRestoration = 'manual'
    content.addEventListener('click', event => this.onClick(event), { signal })
    content.addEventListener('load', () => this.restoreViewport(), { capture: true, signal })
    // A visible diagram can gain links while unrelated render tasks still wait.
    this.contentObserver = new MutationObserver(() => this.prepareContent(content))
    this.contentObserver.observe(content, { childList: true, subtree: true })
    window.addEventListener('popstate', () => { void this.navigate(new URL(window.location.href), 'pop') }, { signal })
    window.addEventListener('pagehide', () => this.savePosition(), { signal })
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      window.addEventListener(event, (event) => {
        if (!(event.target instanceof Element) || !event.target.closest('[data-preview-controls]')) {
          this.restoration = null
        }
      }, { passive: true, signal })
    }
  }

  start() {
    this.entry = this.ensureEntry()
    void this.navigate(new URL(window.location.href), 'initial')
  }

  dispose() {
    this.request?.abort()
    this.lifetime.abort()
    this.contentObserver.disconnect()
    this.restoration = null
    if (this.restoreFrame !== null) window.cancelAnimationFrame(this.restoreFrame)
    this.restoreFrame = null
  }

  get followsEditor() { return this.documentPath === null }
  get canSyncScroll() { return this.followsEditor && !this.keepViewport }

  open(href: string) {
    return this.navigate(new URL(href, window.location.href), 'push')
  }

  refresh() {
    if (this.documentPath) return this.navigate(new URL(this.displayedUrl), 'refresh')
  }

  backToSource() {
    return this.navigate(new URL(`/page/${this.bufnr}`, window.location.href), 'push')
  }

  private notifyLocation() {
    const location: PreviewLocation = { bufnr: this.bufnr, path: this.documentPath,
      fileView: this.fileView, sourceName: this.source?.name || '' }
    const key = JSON.stringify(location)
    if (key !== this.locationKey) {
      this.locationKey = key
      this.callbacks.location?.(location)
    }
  }

  receiveSource(payload: PreviewPayload) {
    const previous = this.source
    if (previous?.changedtick !== undefined && payload.changedtick !== undefined &&
      previous.changedtick > payload.changedtick) return
    const changed = previous && (payload.changedtick !== undefined && previous.changedtick !== undefined
      ? payload.changedtick !== previous.changedtick
      : payload.content?.join('\n') !== previous.content?.join('\n'))
    const renamed = !!previous && previous.name !== payload.name
    this.source = payload
    if (previous?.name !== payload.name) this.notifyLocation()
    if (!this.followsEditor) return
    if (changed && this.rendered) this.resumeEditorScroll()
    this.callbacks.render(payload, renamed)
  }

  resumeEditorScroll() {
    if (!this.followsEditor || (!this.rendered && this.restoration)) return false
    this.keepViewport = false
    this.restoration = null
    return true
  }

  followBuffer(bufnr: number) {
    if (this.followsEditor) {
      void this.navigate(new URL(`/page/${bufnr}`, window.location.href), 'replace')
    }
  }

  afterRender() {
    this.rendered = true
    this.restoreViewport()
  }

  prepareContent(content: ParentNode) {
    prepareLinks(content, this.bufnr, this.documentPath || this.source?.name || null)
  }

  restoreViewport() {
    if (!this.restoration || this.restoreFrame !== null) return
    this.restoreFrame = window.requestAnimationFrame(() => {
      this.restoreFrame = null
      const restore = this.restoration
      if (!restore) return
      if (restore.position) {
        window.scrollTo({ ...restore.position, behavior: 'instant' })
        return
      }
      const rawId = restore.hash.slice(1)
      let id = rawId
      try { id = decodeURIComponent(id) } catch { /* Keep malformed fragments literal. */ }
      const anchor = document.getElementById(rawId) || document.getElementById(id) ||
        [...document.getElementsByName(id)][0]
      if (anchor && this.content.contains(anchor)) {
        anchor.scrollIntoView({ block: 'start', behavior: 'instant' })
      } else if (!id || id.toLowerCase() === 'top' || restore.fallbackToTop) {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      }
    })
  }

  private ensureEntry() {
    const state = window.history.state as HistoryState | null
    if (state?.mkdpEntry) return state.mkdpEntry
    const entry = `${Date.now()}-${++this.nextEntry}`
    window.history.replaceState({ ...state, mkdpEntry: entry }, '')
    return entry
  }

  private rememberPosition() {
    const position = { left: window.scrollX, top: window.scrollY }
    if (this.entry) this.positions.set(this.entry, position)
    return position
  }

  private savePosition() {
    window.history.replaceState({ ...window.history.state, mkdpScroll: this.rememberPosition() }, '')
  }

  private commit(url: URL, mode: NavigationMode) {
    if (mode === 'push' && url.href !== this.displayedUrl) {
      this.savePosition()
      window.history.pushState({}, '', url)
    } else if (mode === 'refresh') {
      window.history.replaceState({ ...window.history.state, mkdpScroll: this.rememberPosition() }, '', url)
    } else {
      window.history.replaceState(mode === 'replace' ? {} : window.history.state, '', url)
    }
    this.entry = this.ensureEntry()
    this.displayedUrl = url.href
    this.notifyLocation()
  }

  private onClick(event: MouseEvent) {
    if (!ordinaryClick(event)) return
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link || !this.content.contains(link) || link.hasAttribute('download')) return
    const target = link.getAttribute('target')
    if (target && target !== '_self') return
    const url = new URL(link.getAttribute('href') || '', window.location.href)
    if (url.origin !== window.location.origin || !/^\/page\/\d+$/.test(url.pathname)) return
    event.preventDefault()
    void this.open(url.href)
  }

  private connect(bufnr: number) {
    if (bufnr === this.bufnr) return
    this.bufnr = bufnr
    this.source = null
    this.rendered = false
    this.callbacks.connect(bufnr)
  }

  private async navigate(url: URL, mode: NavigationMode) {
    if (url.origin !== window.location.origin) return
    const bufnr = Number(url.pathname.match(/^\/page\/(\d+)$/)?.[1])
    if (!bufnr) return
    if (mode !== 'initial') this.rememberPosition()
    const state = window.history.state as HistoryState | null
    let position = mode === 'pop' || mode === 'initial'
      ? (state?.mkdpEntry && this.positions.get(state.mkdpEntry)) || state?.mkdpScroll || null
      : null
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    this.notice.hidden = true
    this.content.setAttribute('aria-busy', 'true')
    const sourceAtStart = this.source
    try {
      let documentPath = url.searchParams.get('path') || null
      let fileView = !!documentPath && url.searchParams.get('view') === 'file'
      const fetchSource = !documentPath && this.documentPath !== null
      let payload = bufnr === this.bufnr ? this.source : null
      const sameDocument = mode !== 'refresh' && !fetchSource && bufnr === this.bufnr &&
        documentPath === this.documentPath && fileView === this.fileView && this.rendered
      const read = async (endpoint: string) => {
        const response = await fetch(endpoint, { signal: request.signal })
        const data = await response.json() as { kind?: string, path: string | null, payload?: PreviewPayload, error?: string }
        if (!response.ok) throw new Error(data.error || 'Cannot open this file')
        return data
      }
      if ((documentPath && !sameDocument) || fetchSource) {
        let data = documentPath
          ? await read(`/api/${fileView ? 'preview' : 'document'}/${bufnr}?${new URLSearchParams({ path: documentPath })}`)
          : await read(`/api/source/${bufnr}`)
        // File-tree aliases identify the live source without reading a second,
        // size-limited copy. This also covers unnamed or renamed source buffers.
        if (data.kind === 'source') data = await read(`/api/source/${bufnr}`)
        if (!data.payload) throw new Error('The preview did not return this file')
        documentPath = data.path
        payload = data.payload
        // HTTP and the live socket can finish in either order. A link back to
        // the source must not roll back a snapshot that arrived during fetch.
        if (!documentPath && bufnr === this.bufnr && this.source) {
          const liveTick = this.source.changedtick
          const snapshotTick = payload.changedtick
          const useLive = liveTick !== undefined && snapshotTick !== undefined
            ? liveTick > snapshotTick || (liveTick === snapshotTick && this.source !== sourceAtStart)
            : this.source !== sourceAtStart
          if (useLive) payload = this.source
        }
        if (documentPath) url.searchParams.set('path', documentPath)
        else {
          url.searchParams.delete('path')
          url.searchParams.delete('view')
          fileView = false
        }
      }
      let image: HTMLImageElement | undefined
      if (!sameDocument && payload?.file?.kind === 'image') {
        // A background image tab still needs a live connection while its decode
        // waits for visibility; otherwise the server could expire in the meantime.
        if (mode === 'initial' && !this.bufnr) this.connect(bufnr)
        const { loadFileImage } = await import('./file-renderer')
        image = await loadFileImage(payload.file.url, payload.name || '', request.signal)
      }
      if (request.signal.aborted) return
      if (mode === 'refresh') position = this.rememberPosition()
      this.documentPath = documentPath
      this.fileView = fileView
      this.connect(bufnr)
      if (!documentPath && payload) this.source = payload
      this.commit(url, mode)
      this.keepViewport = mode === 'push' || mode === 'pop' || !!url.hash || !!position || !!documentPath
      this.restoration = this.keepViewport
        ? {
          hash: url.hash,
          position: position || (url.hash ? null : { left: 0, top: 0 }),
          fallbackToTop: !sameDocument
        }
        : null
      if (sameDocument) {
        this.restoreViewport()
      } else {
        this.rendered = false
        if (payload) this.callbacks.render(payload, true, image)
      }
    } catch (error) {
      if (request.signal.aborted) return
      if (mode === 'initial') {
        this.documentPath = null
        this.fileView = false
        this.connect(bufnr)
        this.displayedUrl = new URL(`/page/${bufnr}`, url).href
        if (this.source) this.callbacks.render(this.source, true)
        this.notifyLocation()
      }
      if (mode === 'pop' || mode === 'initial') {
        window.history.replaceState(window.history.state, '', this.displayedUrl)
        this.entry = this.ensureEntry()
      }
      this.noticeText.textContent = error instanceof Error ? error.message : 'Cannot open this Markdown file'
      this.notice.hidden = false
    } finally {
      if (this.request === request) {
        this.request = null
        this.content.removeAttribute('aria-busy')
      }
    }
  }
}
