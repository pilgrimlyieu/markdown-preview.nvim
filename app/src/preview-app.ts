import type { HLJSApi } from 'highlight.js'
import type { KatexRenderer, MarkdownRendererModule, PreviewOptions, PreviewPayload, PreviewSocket, ScrollPayload } from './types'
import createPreviewSocket from './preview-socket'
import scrollToLine from './scroll'

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
const DOT_SCRIPTS = [
  '/_static/viz.js',
  '/_static/full.render.js'
]

const IDLE_RENDER_TIMEOUT = 500
const ENHANCED_BLOCK_RE = /^[ \t]*(?:(?:```|~~~)[ \t]*(?:mermaid|chart|sequence-diagrams|flowchart|dot|graphviz|plantuml)\b|@startuml\b|(?:gantt|sequenceDiagram|erDiagram|graph (?:TB|BT|RL|LR|TD);?)[ \t]*$)/m
const CODE_FENCE_RE = /^[ \t]*(?:```|~~~)[ \t]*([^`\s~]*)/gm
const ENHANCED_FENCE_LANGS = new Set([
  'chart',
  'dot',
  'flowchart',
  'graphviz',
  'mermaid',
  'plantuml',
  'sequence-diagrams'
])

const lazyScriptLoads = new Map<string, Promise<void>>()

const hasElement = (selector: string) => document.querySelector(selector) !== null

const contentUsesMath = (source: string) => source.indexOf('$') !== -1

const contentUsesMhchem = (source: string) => /\\(?:ce|pu)\s*\{/.test(source)

const contentUsesEnhancedBlocks = (source: string) => ENHANCED_BLOCK_RE.test(source)

const contentUsesHighlighting = (source: string) => {
  CODE_FENCE_RE.lastIndex = 0
  let match = CODE_FENCE_RE.exec(source)
  while (match) {
    const language = (match[1] || '').toLowerCase()
    if (language && !ENHANCED_FENCE_LANGS.has(language)) {
      return true
    }
    match = CODE_FENCE_RE.exec(source)
  }
  return false
}

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

const boolOption = (value: unknown) => value === true || value === 1

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

  private preContent = ''
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private cancelIdleRender: (() => void) | null = null
  private cancelPostRender: (() => void) | null = null
  private pendingHiddenRender: (() => void) | null = null
  private renderVersion = 0
  private latestScroll: ScrollPayload | null = null
  private rendererPromise: Promise<MarkdownRendererModule> | null = null
  private highlighterPromise: Promise<HLJSApi> | null = null
  private highlighter: HLJSApi | null = null
  private katexPromise: Promise<KatexRenderer> | null = null
  private katexRenderer: KatexRenderer | null = null
  private mhchemPromise: Promise<void> | null = null
  private mhchemReady = false
  private markdownRendererKey = ''
  private markdownRenderer: ReturnType<MarkdownRendererModule['createMarkdownRenderer']> | null = null
  private pendingRenderUpgrades: Record<string, number | null> = {}
  private bufnr = -1
  private socket: PreviewSocket | null = null
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
    this.startSocket(this.bufnrFromLocation())
  }

  private bufnrFromLocation() {
    const match = window.location.pathname.match(/(\d+)$/)
    return match ? Number(match[1]) : 0
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

  private loadHighlighter() {
    if (!this.highlighterPromise) {
      this.highlighterPromise = import('./highlight')
        .then((module) => {
          this.highlighter = module.default
          return this.highlighter
        })
        .catch((error) => {
          this.highlighterPromise = null
          throw error
        })
    }
    return this.highlighterPromise
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

  private rendererKey(options: PreviewOptions, highlighterReady: boolean, katexReady: boolean) {
    return JSON.stringify({
      options,
      highlighterReady,
      katexReady
    })
  }

  private getMarkdownRenderer(markdownRenderer: MarkdownRendererModule, options: PreviewOptions) {
    const key = this.rendererKey(options, Boolean(this.highlighter), Boolean(this.katexRenderer))
    if (!this.markdownRenderer || this.markdownRendererKey !== key) {
      this.markdownRenderer = markdownRenderer.createMarkdownRenderer(options, this.highlighter, this.katexRenderer)
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
    this.cancelQueuedRender()
    this.pendingHiddenRender = null
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
    this.pendingHiddenRender = null
    if (renderWork) {
      renderWork()
      return
    }
    if (this.latestScroll) {
      this.onSyncScroll(this.latestScroll)
    }
  }

  private handleVisibilityChange() {
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
      this.renderEnhancedBlocks(markdownRenderer, options).catch(console.error)
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

  private async renderEnhancedBlocks(markdownRenderer: MarkdownRendererModule, options: PreviewOptions) {
    const tasks: Array<Promise<unknown>> = []

    const mermaidNodes = document.querySelectorAll<HTMLElement>('.mermaid')
    if (mermaidNodes.length) {
      tasks.push(
        import('mermaid').then((module) => {
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
          return mermaid.run({ nodes: mermaidNodes, suppressErrors: true })
        })
      )
    }
    if (hasElement('.chartjs')) {
      tasks.push(import('./chart-renderer').then((module) => module.default()))
    }
    if (hasElement('.plantuml-diagram')) {
      tasks.push(import('./plantuml-renderer').then((module) => module.default()))
    }
    if (hasElement('.sequence-diagrams')) {
      tasks.push(loadLazyScripts(SEQUENCE_DIAGRAM_SCRIPTS).then(markdownRenderer.renderDiagram))
    }
    if (hasElement('div.flowchart')) {
      tasks.push(loadLazyScripts(FLOWCHART_SCRIPTS).then(markdownRenderer.renderFlowchart))
    }
    if (hasElement('.dot')) {
      tasks.push(loadLazyScripts(DOT_SCRIPTS).then(markdownRenderer.renderDot))
    }

    await Promise.all(tasks)
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
    this.latestScroll = null

    const previousSocket = this.socket
    window.history.replaceState(null, '', `/page/${bufnr}`)

    const socket = createPreviewSocket(bufnr)
    this.socket = socket

    socket.on('connect', () => console.log('connect success'))
    socket.on('disconnect', () => console.log('disconnect'))
    socket.on('close', () => this.onClose())
    socket.on('refresh_content', (payload) => this.onRefreshContent(payload as PreviewPayload))
    socket.on('sync_scroll', (payload) => this.onSyncScroll(payload as ScrollPayload))
    socket.on('close_page', () => this.onClose())
    socket.on('change_bufnr', (nextBufnr) => this.startSocket(Number(nextBufnr)))

    if (previousSocket) {
      previousSocket.close()
    }
  }

  private onClose() {
    this.invalidatePendingRender()
    console.log('close')
    window.close()
  }

  private onSyncScroll(scrollPayload: ScrollPayload) {
    this.latestScroll = scrollPayload
    if (this.isPreviewHidden()) {
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

  private applyRenderedContent({
    renderedContent,
    name,
    pageTitle,
    theme,
    options,
    scrollPayload,
    refreshScroll
  }: {
    renderedContent: string
    name: string
    pageTitle: string
    theme: string
    options: PreviewOptions
    scrollPayload: ScrollPayload
    refreshScroll: () => void
  }) {
    const latestScroll = this.latestScroll || scrollPayload
    const displayName = filenameWithoutExtension(name)

    this.nameNode.textContent = displayName
    document.title = (pageTitle || '').replace(/\$\{name\}/, displayName)
    this.contentNode.innerHTML = renderedContent
    this.pageContainer.contentEditable = boolOption(options.content_editable) ? 'true' : 'false'
    this.header.hidden = !(!boolOption(options.disable_filename))
    this.setTheme(theme)

    scrollToLine.invalidate()
    refreshScroll()
  }

  private upgradeCodeHighlighting(
    renderVersion: number,
    markdownRenderer: MarkdownRendererModule,
    options: PreviewOptions,
    source: string,
    applyRender: (renderedContent: string) => void
  ) {
    const clearPending = this.startRenderUpgrade('highlight', renderVersion)
    if (!clearPending) {
      return
    }
    this.loadHighlighter()
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

  private onRefreshContent(payload: PreviewPayload) {
    const options = payload.options || {}
    const content = payload.content || []
    const cursor = payload.cursor || [0, 1, 1, 0]
    const pageTitle = payload.pageTitle || ''
    const name = payload.name || ''
    const theme = this.resolveTheme(payload.theme)
    const winline = payload.winline || 1
    const winheight = payload.winheight || 1
    const isActive = payload.isActive !== false
    const newContent = content.join('\n')
    const isInitialContent = this.preContent === ''
    const refreshContent = this.preContent !== newContent
    this.preContent = newContent

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
        return
      }
      refreshScroll()
      return
    }

    const renderVersion = this.invalidatePendingRender()
    const refreshEnhancedBlocks = contentUsesEnhancedBlocks(newContent)
    const refreshHighlightedBlocks = contentUsesHighlighting(newContent)
    const refreshMathBlocks = contentUsesMath(newContent)

    const applyRender = (
      markdownRenderer: MarkdownRendererModule,
      renderedContent: string
    ) => {
      this.applyRenderedContent({
        renderedContent,
        name,
        pageTitle,
        theme,
        options,
        scrollPayload,
        refreshScroll
      })
      if (refreshEnhancedBlocks) {
        this.schedulePostRender(renderVersion, markdownRenderer, options)
      }
      if (refreshHighlightedBlocks && !this.highlighter) {
        this.upgradeCodeHighlighting(renderVersion, markdownRenderer, options, newContent, (nextContent) => {
          applyRender(markdownRenderer, nextContent)
        })
      }
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
}
