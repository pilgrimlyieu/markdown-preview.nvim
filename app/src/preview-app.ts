import type { KatexRenderer, MarkdownRendererModule, PreviewOptions, PreviewPayload, PreviewSocket, ScrollPayload } from './types'
import { HighlightClient } from './highlight-client'
import createPreviewSocket from './preview-socket'
import { PreviewNavigation } from './preview-navigation'
import { PreviewControls } from './preview-controls'
import scrollToLine from './scroll'
import { boolOption } from './utils'

const SEQUENCE_DIAGRAM_SCRIPTS = [
  '/_static/underscore-min.js',
  '/_static/webfont.js',
  '/_static/snap.svg.min.js',
  '/_static/tweenlite.min.js',
  '/_static/sequence-diagram-min.js'
]
const FLOWCHART_SCRIPTS = [
  '/_static/raphael@2.3.0.min.js',
  '/_static/flowchart@1.13.0.min.js'
]

const IDLE_RENDER_TIMEOUT = 500

const lazyScriptLoads = new Map<string, Promise<void>>()

const contentUsesMath = (source: string) => source.indexOf('$') !== -1

const contentUsesMhchem = (source: string) => /\\(?:ce|pu)\s*\{/.test(source)

function loadLazyScript(src: string) {
  const cached = lazyScriptLoads.get(src)
  if (cached) {
    return cached
  }

  const load = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => {
      lazyScriptLoads.delete(src)
      script.remove()
      reject(new Error(`Failed to load ${src}`))
    }
    document.head.appendChild(script)
  })

  lazyScriptLoads.set(src, load)
  return load
}

const loadLazyScripts = (sources: string[]) =>
  sources.reduce<Promise<void>>((chain, src) => chain.then(() => loadLazyScript(src)), Promise.resolve())

const scheduleIdleWork = (callback: () => void) => {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: IDLE_RENDER_TIMEOUT })
    return () => window.cancelIdleCallback && window.cancelIdleCallback(id)
  }

  const id = setTimeout(callback, 0)
  return () => clearTimeout(id)
}

const filenameWithoutExtension = (name: string) => {
  const basename = name.split(/\\|\//).pop() || ''
  const tokens = basename.split('.')
  return tokens.length > 1 ? tokens.slice(0, -1).join('.') : tokens[0]
}

function requireElement<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`missing preview element: ${selector}`)
  }
  return element
}

export class PreviewApp {
  private readonly main = requireElement<HTMLElement>('main')
  private readonly pageContainer = requireElement<HTMLElement>('#page-ctn')
  private readonly header = requireElement<HTMLElement>('#page-header')
  private readonly nameNode = requireElement<HTMLElement>('#page-title-name')
  private readonly themeToggle = requireElement<HTMLElement>('#toggle-theme')
  private readonly themeInput = requireElement<HTMLInputElement>('#theme')
  private readonly contentNode = requireElement<HTMLElement>('#markdown-body')

  private preContent: string | null = null
  private preChangedTick: number | undefined
  private preOptionsKey = ''
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private cancelIdleRender: (() => void) | null = null
  private cancelPostRender: (() => void) | null = null
  private pendingHiddenRender: (() => void) | null = null
  private renderVersion = 0
  private latestScroll: ScrollPayload | null = null
  private pendingHiddenScroll: ScrollPayload | null = null
  private rendererPromise: Promise<MarkdownRendererModule> | null = null
  private highlighter: HighlightClient | null = null
  private highlighterOptionsKey = ''
  private highlightFrame: number | null = null
  private katexPromise: Promise<KatexRenderer> | null = null
  private katexRenderer: KatexRenderer | null = null
  private mhchemPromise: Promise<void> | null = null
  private mhchemReady = false
  private markdownRendererKey = ''
  private markdownRenderer: ReturnType<MarkdownRendererModule['createMarkdownRenderer']> | null = null
  private pendingRenderUpgrades: Record<string, number | null> = {}
  private enhancedDisposers: Array<() => void> = []
  private bufnr = -1
  private socket: PreviewSocket | null = null
  private navigation: PreviewNavigation | null = null
  private controls: PreviewControls | null = null
  private theme = ''

  constructor() {
    this.header.addEventListener('mouseenter', () => {
      this.themeToggle.hidden = false
    })
    this.header.addEventListener('mouseleave', () => {
      this.themeToggle.hidden = true
    })
    this.themeInput.addEventListener('change', () => {
      this.setTheme(this.theme === 'light' ? 'dark' : 'light')
    })
    document.addEventListener('visibilitychange', () => {
      this.handleVisibilityChange()
    })
  }

  start() {
    this.navigation = new PreviewNavigation(this.contentNode, {
      connect: bufnr => this.startSocket(bufnr),
      render: (payload, newDocument, image) => {
        if (newDocument) this.preContent = null
        this.onRefreshContent(payload, image)
      },
      location: location => this.controls?.update(location)
    })
    this.controls = new PreviewControls(this.navigation)
    this.navigation.start()
  }

  private loadMarkdownRenderer() {
    if (!this.rendererPromise) {
      this.rendererPromise = import('./markdown-renderer')
        .catch((error) => {
          this.rendererPromise = null
          throw error
        })
    }
    return this.rendererPromise
  }

  private async loadKatexRenderer(needsMhchem: boolean) {
    if (!this.katexPromise) {
      this.katexPromise = Promise.all([
        import('katex'),
        import('katex/dist/katex.min.css')
      ])
        .then(([module]) => {
          this.katexRenderer = module.default
          return this.katexRenderer
        })
        .catch((error) => {
          this.katexPromise = null
          throw error
        })
    }

    const renderer = await this.katexPromise
    if (needsMhchem && !this.mhchemReady) {
      if (!this.mhchemPromise) {
        this.mhchemPromise = import('katex/dist/contrib/mhchem.mjs')
          .then(() => {
            this.mhchemReady = true
          })
          .catch((error) => {
            this.mhchemPromise = null
            throw error
          })
      }
      await this.mhchemPromise
    }
    return renderer
  }

  private mathDependenciesReady(source: string) {
    return this.katexRenderer && (!contentUsesMhchem(source) || this.mhchemReady)
  }

  private rendererKey(options: PreviewOptions, katexReady: boolean) {
    const { content_editable, disable_filename, disable_sync_scroll, sync_scroll_type, ...renderOptions } = options
    return JSON.stringify({
      options: renderOptions,
      katexReady
    })
  }

  private getHighlighter(options: PreviewOptions) {
    const highlighterOptionsKey = JSON.stringify(options.highlight || {})
    if (!this.highlighter || this.highlighterOptionsKey !== highlighterOptionsKey) {
      this.highlighter?.dispose()
      this.highlighterOptionsKey = highlighterOptionsKey
      this.highlighter = new HighlightClient(options.highlight || {}, (id, html, source) => {
        this.applyCodeHighlight(id, html, source)
      })
      this.highlighter.setPaused(this.isPreviewHidden())
      this.markdownRenderer = null
    }
    return this.highlighter
  }

  private getMarkdownRenderer(markdownRenderer: MarkdownRendererModule, options: PreviewOptions) {
    const highlighter = this.getHighlighter(options)
    const key = this.rendererKey(options, Boolean(this.katexRenderer))
    if (!this.markdownRenderer || this.markdownRendererKey !== key) {
      this.markdownRenderer = markdownRenderer.createMarkdownRenderer(options, highlighter, this.katexRenderer)
      this.markdownRendererKey = key
    }
    return this.markdownRenderer
  }

  private cancelQueuedRender() {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }
    if (this.cancelIdleRender) {
      this.cancelIdleRender()
      this.cancelIdleRender = null
    }
    if (this.cancelPostRender) {
      this.cancelPostRender()
      this.cancelPostRender = null
    }
  }

  private invalidatePendingRender() {
    this.renderVersion += 1
    this.highlighter?.retain(new Set())
    this.cancelQueuedRender()
    this.pendingHiddenRender = null
    this.pendingHiddenScroll = null
    return this.renderVersion
  }

  private isPreviewHidden() {
    return document.hidden === true
  }

  private deferUntilVisible(renderWork: () => void) {
    if (!this.isPreviewHidden()) {
      return false
    }
    this.pendingHiddenRender = renderWork
    return true
  }

  private flushVisibleWork() {
    const renderWork = this.pendingHiddenRender
    const pendingScroll = this.pendingHiddenScroll
    this.pendingHiddenRender = null
    this.pendingHiddenScroll = null
    if (renderWork) {
      renderWork()
      return
    }
    if (pendingScroll) {
      this.onSyncScroll(pendingScroll)
    }
  }

  private handleVisibilityChange() {
    this.highlighter?.setPaused(this.isPreviewHidden())
    if (!this.isPreviewHidden()) {
      this.flushVisibleWork()
    }
  }

  private scheduleIdleRender(renderVersion: number, renderWork: () => void) {
    this.cancelIdleRender = scheduleIdleWork(() => {
      this.cancelIdleRender = null
      if (renderVersion !== this.renderVersion) {
        return
      }
      renderWork()
    })
  }

  private schedulePostRender(renderVersion: number, markdownRenderer: MarkdownRendererModule, options: PreviewOptions) {
    this.cancelPostRender = scheduleIdleWork(() => {
      this.cancelPostRender = null
      if (renderVersion !== this.renderVersion) {
        return
      }
      this.renderEnhancedBlocks(markdownRenderer, options, renderVersion).then(() => {
        if (renderVersion === this.renderVersion) this.navigation?.afterRender()
      }).catch(console.error)
    })
  }

  private startRenderUpgrade(type: string, renderVersion: number) {
    if (this.pendingRenderUpgrades[type] === renderVersion) {
      return null
    }
    this.pendingRenderUpgrades[type] = renderVersion
    return () => {
      if (this.pendingRenderUpgrades[type] === renderVersion) {
        this.pendingRenderUpgrades[type] = null
      }
    }
  }

  private async renderEnhancedBlocks(markdownRenderer: MarkdownRendererModule, options: PreviewOptions, version: number) {
    const tasks: Array<Promise<unknown>> = []
    // A source version can replace its DOM more than once (for example after
    // KaTeX loads). Capture nodes now and check their membership after awaiting.
    const current = <T extends HTMLElement>(nodes: Iterable<T>) => version === this.renderVersion
      ? [...nodes].filter(node => this.contentNode.contains(node))
      : []

    const mermaidNodes = this.contentNode.querySelectorAll<HTMLElement>('.mermaid')
    if (mermaidNodes.length) {
      tasks.push(
        import('mermaid').then((module) => {
          const nodes = current(mermaidNodes)
          if (!nodes.length) return
          const mermaid = module.default
          const mermaidTheme = this.theme === 'dark' ? 'dark' : 'default'
          const mermaidConfig = {
            startOnLoad: false,
            theme: mermaidTheme,
            ...(options.maid || {})
          } as Parameters<typeof mermaid.initialize>[0]
          mermaid.initialize({
            ...mermaidConfig
          })
          return mermaid.run({ nodes, suppressErrors: true })
        })
      )
    }
    const charts = this.contentNode.querySelectorAll<HTMLCanvasElement>('canvas.chartjs')
    if (charts.length) {
      tasks.push(import('./chart-renderer').then((module) => {
        const dispose = module.default(current(charts))
        if (dispose) this.enhancedDisposers.push(dispose)
      }))
    }
    const plantuml = this.contentNode.querySelectorAll<HTMLElement>('.plantuml-diagram')
    if (plantuml.length) {
      tasks.push(import('./plantuml-renderer').then((module) => module.default(current(plantuml))))
    }
    const sequences = this.contentNode.querySelectorAll<HTMLElement>('.sequence-diagrams')
    if (sequences.length) {
      tasks.push(loadLazyScripts(SEQUENCE_DIAGRAM_SCRIPTS).then(() => markdownRenderer.renderDiagram(current(sequences))))
    }
    const flowcharts = this.contentNode.querySelectorAll<HTMLElement>('div.flowchart')
    if (flowcharts.length) {
      tasks.push(loadLazyScripts(FLOWCHART_SCRIPTS).then(() => markdownRenderer.renderFlowchart(current(flowcharts))))
    }
    const dots = this.contentNode.querySelectorAll<HTMLElement>('.dot')
    if (dots.length) {
      tasks.push(markdownRenderer.renderDot(dots))
    }

    await Promise.all(tasks)
  }

  private clearEnhancedBlocks() {
    for (const dispose of this.enhancedDisposers.splice(0)) {
      try { dispose() } catch (error) { console.error(error) }
    }
  }

  private setTheme(theme: string) {
    this.theme = theme || 'light'
    this.main.dataset.theme = this.theme
    this.themeInput.checked = this.theme === 'dark'
  }

  private resolveTheme(theme?: string) {
    if (this.theme) {
      return this.theme
    }
    if (theme === 'light' || theme === 'dark') {
      return theme
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }

  private startSocket(bufnr: number) {
    if (this.bufnr === bufnr) {
      return
    }
    this.invalidatePendingRender()
    this.bufnr = bufnr
    this.preContent = null
    this.latestScroll = null

    const previousSocket = this.socket
    const socket = createPreviewSocket(bufnr)
    this.socket = socket

    socket.on('connect', () => console.log('connect success'))
    socket.on('disconnect', () => console.log('disconnect'))
    socket.on('close', () => { if (this.socket === socket) this.onClose() })
    socket.on('refresh_content', (payload) => {
      if (this.socket === socket) this.navigation?.receiveSource(payload as PreviewPayload)
    })
    socket.on('sync_scroll', (payload) => {
      if (this.socket !== socket) return
      // A deduplicated refresh still carries current filename/options. Pure
      // cursor events have no content and keep the existing lightweight path.
      if ((payload as PreviewPayload).content) this.navigation?.receiveSource(payload as PreviewPayload)
      if (this.navigation?.resumeEditorScroll()) {
        this.onSyncScroll(payload as ScrollPayload)
      }
    })
    socket.on('close_page', () => { if (this.socket === socket) this.onClose() })
    socket.on('change_bufnr', (nextBufnr) => {
      if (this.socket === socket) this.navigation?.followBuffer(Number(nextBufnr))
    })

    if (previousSocket) {
      previousSocket.close()
    }
  }

  private onClose() {
    this.invalidatePendingRender()
    this.clearEnhancedBlocks()
    this.navigation?.dispose()
    this.controls?.dispose()
    this.socket?.close()
    this.socket = null
    this.highlighter?.dispose()
    this.highlighter = null
    if (this.highlightFrame !== null) window.cancelAnimationFrame(this.highlightFrame)
    this.highlightFrame = null
    console.log('close')
    window.close()
  }

  private onSyncScroll(scrollPayload: ScrollPayload) {
    if (this.navigation && !this.navigation.canSyncScroll) return
    this.latestScroll = scrollPayload
    if (this.isPreviewHidden()) {
      this.pendingHiddenScroll = scrollPayload
      return
    }

    const {
      options,
      isActive,
      winline,
      winheight,
      cursor,
      len
    } = scrollPayload

    if (isActive && !boolOption(options.disable_sync_scroll)) {
      const syncScrollType = options.sync_scroll_type || 'middle'
      const syncScroll = scrollToLine[syncScrollType] || scrollToLine.middle
      syncScroll({
        cursor: cursor[1],
        winline,
        winheight,
        len
      })
    }
  }

  private updatePageMetadata(payload: PreviewPayload) {
    const options = payload.options || {}
    const displayName = filenameWithoutExtension(payload.name || '')
    this.nameNode.textContent = displayName
    document.title = (payload.pageTitle || '').replace(/\$\{name\}/, displayName)
    this.pageContainer.contentEditable = !payload.file && boolOption(options.content_editable) ? 'true' : 'false'
    this.header.hidden = boolOption(options.disable_filename)
    this.setTheme(this.resolveTheme(payload.theme))
  }

  private applyRenderedContent(renderedContent: string, refreshScroll: () => void) {
    const template = document.createElement('template')
    template.innerHTML = renderedContent
    // Resolve resources while detached, before the browser can request them
    // against the previous document's URL or directory.
    this.navigation?.prepareContent(template.content)
    this.clearEnhancedBlocks()
    this.contentNode.replaceChildren(template.content)
    this.highlighter?.retain(new Set(
      [...this.contentNode.querySelectorAll<HTMLElement>('pre[data-highlight-id]')]
        .map(node => Number(node.dataset.highlightId))
    ))
    scrollToLine.invalidate()
    refreshScroll()
    this.navigation?.afterRender()
  }

  private applyCodeHighlight(id: number, html: string, source: string) {
    let changed = false
    const nodes = this.contentNode.querySelectorAll<HTMLElement>(`pre[data-highlight-id="${id}"]`)
    for (const node of nodes) {
      // IDs belong to a source/language pair; checking the text also protects
      // edits made directly in the preview while highlighting was in flight.
      if (node.textContent === source) {
        node.outerHTML = html
        changed = true
      }
    }
    // Consume HTML before the client sends its next request. Only scroll work
    // waits for a frame, so suspended frames cannot retain a second HTML cache.
    if (!changed || this.highlightFrame !== null) return
    this.highlightFrame = window.requestAnimationFrame(() => {
      this.highlightFrame = null
      scrollToLine.invalidate()
      if (this.latestScroll) this.onSyncScroll(this.latestScroll)
      this.navigation?.restoreViewport()
    })
  }

  private upgradeMathRendering(
    renderVersion: number,
    markdownRenderer: MarkdownRendererModule,
    options: PreviewOptions,
    source: string,
    applyRender: (renderedContent: string) => void
  ) {
    const clearPending = this.startRenderUpgrade('math', renderVersion)
    if (!clearPending) {
      return
    }
    this.loadKatexRenderer(contentUsesMhchem(source))
      .then(() => {
        clearPending()
        if (renderVersion !== this.renderVersion) {
          return
        }
        const md = this.getMarkdownRenderer(markdownRenderer, options)
        applyRender(md.render(source))
      })
      .catch((error) => {
        clearPending()
        console.error(error)
      })
  }

  private onRefreshContent(payload: PreviewPayload, image?: HTMLImageElement) {
    // Update on receipt so a delayed render cannot restore older metadata.
    this.updatePageMetadata(payload)
    if (payload.file) {
      this.showFile(payload, image)
      return
    }
    const options = payload.options || {}
    const content = payload.content || []
    const cursor = payload.cursor || [0, 1, 1, 0]
    const winline = payload.winline || 1
    const winheight = payload.winheight || 1
    const isActive = payload.isActive !== false
    const sameTick = this.preContent !== null && payload.changedtick !== undefined && payload.changedtick === this.preChangedTick
    const newContent = sameTick ? this.preContent! : content.join('\n')
    const optionsKey = this.rendererKey(options, false)
    const isInitialContent = this.preContent === null
    const refreshContent = this.preContent !== newContent || this.preOptionsKey !== optionsKey
    this.preContent = newContent
    this.preChangedTick = payload.changedtick
    this.preOptionsKey = optionsKey

    const scrollPayload: ScrollPayload = {
      options,
      isActive,
      winline,
      winheight,
      cursor,
      len: content.length
    }
    this.latestScroll = scrollPayload

    const refreshScroll = () => this.onSyncScroll(this.latestScroll || scrollPayload)

    if (!refreshContent) {
      if (this.isPreviewHidden()) {
        this.pendingHiddenScroll = scrollPayload
        return
      }
      refreshScroll()
      return
    }

    const renderVersion = this.invalidatePendingRender()
    const refreshMathBlocks = contentUsesMath(newContent)

    const applyRender = (
      markdownRenderer: MarkdownRendererModule,
      renderedContent: string
    ) => {
      this.applyRenderedContent(renderedContent, refreshScroll)
      this.schedulePostRender(renderVersion, markdownRenderer, options)
      if (refreshMathBlocks && !this.mathDependenciesReady(newContent)) {
        this.upgradeMathRendering(renderVersion, markdownRenderer, options, newContent, (nextContent) => {
          applyRender(markdownRenderer, nextContent)
        })
      }
    }

    const refreshRender = (deferRender: boolean) => {
      this.loadMarkdownRenderer()
        .then((markdownRenderer) => {
          if (renderVersion !== this.renderVersion) {
            return
          }
          const md = this.getMarkdownRenderer(markdownRenderer, options)
          const renderWork = () => {
            applyRender(markdownRenderer, md.render(newContent))
          }
          if (deferRender) {
            this.scheduleIdleRender(renderVersion, renderWork)
          } else {
            renderWork()
          }
        })
        .catch(console.error)
    }

    const runRefresh = (deferRender: boolean) => {
      if (this.deferUntilVisible(() => refreshRender(deferRender))) {
        return
      }
      refreshRender(deferRender)
    }

    if (isInitialContent) {
      runRefresh(false)
      return
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      runRefresh(true)
    }, 16)
  }

  private showFile(payload: PreviewPayload, image?: HTMLImageElement) {
    const version = this.invalidatePendingRender()
    this.clearEnhancedBlocks()
    this.preContent = null
    this.latestScroll = null
    const show = () => {
      void import('./file-renderer').then(({ renderFile }) => {
        if (version !== this.renderVersion) return
        this.applyRenderedContent(renderFile(payload, this.getHighlighter(payload.options || {})), () => {})
        if (image) this.contentNode.querySelector('.file-image-slot')?.replaceWith(image)
      }).catch(console.error)
    }
    if (!this.deferUntilVisible(show)) show()
  }
}
