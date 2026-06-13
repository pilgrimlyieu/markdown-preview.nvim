import React from 'react'
import Head from 'next/head'

import createPreviewSocket from './preview-socket'
import scrollToLine from './scroll'

const MERMAID_SCRIPTS = ['/_static/mermaid.min.js']
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
const KATEX_STYLES = ['/_static/katex@0.15.3.css']
const KATEX_SCRIPTS = ['/_static/katex@0.15.3.js']
const MHCHEM_SCRIPT = '/_static/mhchem.min.js'
const IDLE_RENDER_TIMEOUT = 500
const lazyStyleLoads = {}
const lazyScriptLoads = {}
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

const hasElement = (selector) => document.querySelector(selector) !== null

const contentUsesMath = (source) => source.indexOf('$') !== -1

const contentUsesMhchem = (source) => /\\(?:ce|pu)\s*\{/.test(source)

const contentUsesEnhancedBlocks = (source) => ENHANCED_BLOCK_RE.test(source)

const contentUsesHighlighting = (source) => {
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

const loadLazyStyle = (href) => {
  if (lazyStyleLoads[href]) {
    return lazyStyleLoads[href]
  }

  lazyStyleLoads[href] = new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.onload = resolve
    link.onerror = () => {
      delete lazyStyleLoads[href]
      link.remove()
      reject(new Error(`Failed to load ${href}`))
    }
    document.head.appendChild(link)
  })

  return lazyStyleLoads[href]
}

const loadLazyScript = (src) => {
  if (lazyScriptLoads[src]) {
    return lazyScriptLoads[src]
  }

  lazyScriptLoads[src] = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = resolve
    script.onerror = () => {
      delete lazyScriptLoads[src]
      script.remove()
      reject(new Error(`Failed to load ${src}`))
    }
    document.head.appendChild(script)
  })

  return lazyScriptLoads[src]
}

const loadLazyStyles = (hrefs) =>
  hrefs.reduce((chain, href) => chain.then(() => loadLazyStyle(href)), Promise.resolve())

const loadLazyScripts = (sources) =>
  sources.reduce((chain, src) => chain.then(() => loadLazyScript(src)), Promise.resolve())

const loadRenderDependencies = (source) => {
  if (!contentUsesMath(source)) {
    return Promise.resolve()
  }

  const scripts = contentUsesMhchem(source)
    ? KATEX_SCRIPTS.concat(MHCHEM_SCRIPT)
    : KATEX_SCRIPTS
  return Promise.all([
    loadLazyStyles(KATEX_STYLES),
    loadLazyScripts(scripts)
  ])
}

const scheduleIdleWork = (callback) => {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: IDLE_RENDER_TIMEOUT })
    return () => window.cancelIdleCallback && window.cancelIdleCallback(id)
  }

  const id = setTimeout(callback, 0)
  return () => clearTimeout(id)
}

const renderWithLazyScripts = (sources, render) => {
  loadLazyScripts(sources)
    .then(render)
    .catch((error) => {
      console.error(error)
    })
}

const renderWithLazyModule = (loadRenderer) => {
  loadRenderer()
    .then((module) => module.default())
    .catch((error) => {
      console.error(error)
    })
}

const renderChart = () => renderWithLazyModule(() => import('./chart-renderer'))

const renderPlantuml = () => renderWithLazyModule(() => import('./plantuml-renderer'))

const renderMermaid = (options, theme) => {
  const mermaidNodes = document.querySelectorAll('.mermaid')
  if (!mermaidNodes.length) {
    return
  }

  renderWithLazyScripts(MERMAID_SCRIPTS, () => {
    const mermaid = window.mermaid
    if (!mermaid) {
      return
    }
    try {
      mermaid.initialize({ theme: (theme || 'light'), ...(options.maid || {}) })
      if (typeof mermaid.run === 'function') {
        mermaid.run({ nodes: mermaidNodes }).catch(() => {})
      } else {
        mermaid.init(undefined, mermaidNodes)
      }
    } catch (e) {
    }
  })
}

const renderEnhancedBlocks = (markdownRenderer, options, theme) => {
  renderMermaid(options, theme)
  if (hasElement('.chartjs')) {
    renderChart()
  }
  if (hasElement('.plantuml-diagram')) {
    renderPlantuml()
  }
  if (hasElement('.sequence-diagrams')) {
    renderWithLazyScripts(SEQUENCE_DIAGRAM_SCRIPTS, markdownRenderer.renderDiagram)
  }
  if (hasElement('div.flowchart')) {
    renderWithLazyScripts(FLOWCHART_SCRIPTS, markdownRenderer.renderFlowchart)
  }
  if (hasElement('.dot')) {
    renderWithLazyScripts(DOT_SCRIPTS, markdownRenderer.renderDot)
  }
}

export default class PreviewPage extends React.Component {
  constructor(props) {
    super(props)

    this.preContent = ''
    this.renderTimer = undefined
    this.cancelIdleRender = null
    this.cancelPostRender = null
    this.renderVersion = 0
    this.latestScroll = null
    this.rendererPromise = null
    this.highlighterPromise = null
    this.mdUsesHighlighter = false
    this.bufnr = -1;

    this.state = {
      name: '',
      cursor: '',
      content: '',
      pageTitle: '',
      theme: '',
      themeModeIsVisible: false,
      contentEditable: false,
      disableFilename: 1
    }
    this.showThemeButton = this.showThemeButton.bind(this)
    this.hideThemeButton = this.hideThemeButton.bind(this)
    this.handleThemeChange = this.handleThemeChange.bind(this)
  }

  loadMarkdownRenderer() {
    if (!this.rendererPromise) {
      this.rendererPromise = import('./markdown-renderer')
        .catch((error) => {
          this.rendererPromise = null
          throw error
        })
    }
    return this.rendererPromise
  }

  loadHighlighter() {
    if (!this.highlighterPromise) {
      this.highlighterPromise = import('./highlight')
        .then((module) => module.default)
        .catch((error) => {
          this.highlighterPromise = null
          throw error
        })
    }
    return this.highlighterPromise
  }

  cancelQueuedRender() {
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer)
      this.renderTimer = undefined
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

  invalidatePendingRender() {
    this.renderVersion += 1
    this.cancelQueuedRender()
    return this.renderVersion
  }

  scheduleIdleRender(renderVersion, renderWork) {
    this.cancelIdleRender = scheduleIdleWork(() => {
      this.cancelIdleRender = null
      if (renderVersion !== this.renderVersion) {
        return
      }
      renderWork()
    })
  }

  schedulePostRender(renderVersion, markdownRenderer, options) {
    this.cancelPostRender = scheduleIdleWork(() => {
      this.cancelPostRender = null
      if (renderVersion !== this.renderVersion) {
        return
      }
      renderEnhancedBlocks(markdownRenderer, options, this.state.theme)
    })
  }

  handleThemeChange() {
    this.setState((state) => ({
      theme: state.theme === 'light' ? 'dark' : 'light',
    }))
  }

  showThemeButton() {
    this.setState({ themeModeIsVisible: true })
  }

  hideThemeButton() {
    this.setState({ themeModeIsVisible: false })
  }

  startSocket(bufnr) {
    if (this.bufnr === bufnr) {
      return;
    }
    this.invalidatePendingRender()
    this.bufnr = bufnr;
    this.latestScroll = null

    // Close the previous socket
    const tmpSocket = window.socket

    window.history.replaceState(null, '', `/${bufnr}`)

    const socket = createPreviewSocket(bufnr)

    window.socket = socket

    socket.on('connect', this.onConnect.bind(this))

    socket.on('disconnect', this.onDisconnect.bind(this))

    socket.on('close', this.onClose.bind(this))

    socket.on('refresh_content', this.onRefreshContent.bind(this))

    socket.on('sync_scroll', this.onSyncScroll.bind(this))

    socket.on('close_page', this.onClose.bind(this))

    socket.on('change_bufnr', this.onChangeBufnr.bind(this))

    if (tmpSocket) {
      tmpSocket.close()
    }
  }

  componentDidMount() {
    this.startSocket(parseFloat(window.location.pathname.split('/')[2]))
  }

  onConnect() {
    console.log('connect success')
  }

  onDisconnect() {
    console.log('disconnect')
  }

  onClose() {
    this.invalidatePendingRender()
    console.log('close')
    window.close()
  }

  onChangeBufnr(bufnr) {
    this.startSocket(bufnr)
  }

  onSyncScroll(scrollPayload) {
    this.latestScroll = scrollPayload

    const {
      options = {},
      isActive,
      winline,
      winheight,
      cursor,
      len
    } = scrollPayload

    if (isActive && !options.disable_sync_scroll) {
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

  onRefreshContent({
    options = {},
    isActive,
    winline,
    winheight,
    cursor,
    pageTitle = '',
    theme,
    name = '',
    content
  }) {
    // Theme already applied
    if (this.state.theme) {
      theme = this.state.theme
    }
    // Define the theme according to the preferences of the system
    else if (!theme || !['light', 'dark'].includes(theme)) {
      if (
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      ) {
        theme = 'dark'
      }
    }

    const newContent = content.join('\n')
    const isInitialContent = this.preContent === ''
    const refreshContent = this.preContent !== newContent
    this.preContent = newContent

    const scrollPayload = {
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
      refreshScroll()
      return
    }

    const renderVersion = this.invalidatePendingRender()
    const refreshEnhancedBlocks = contentUsesEnhancedBlocks(newContent)
    const refreshHighlightedBlocks = contentUsesHighlighting(newContent)

    const applyRender = (markdownRenderer, renderedContent) => {
      const latestScroll = this.latestScroll || scrollPayload
      this.setState({
        cursor: latestScroll.cursor,
        name: ((name) => {
          let tokens = name.split(/\\|\//).pop().split('.');
          return tokens.length > 1 ? tokens.slice(0, -1).join('.') : tokens[0];
        })(name),
        content: renderedContent,
        pageTitle,
        theme,
        contentEditable: options.content_editable,
        disableFilename: options.disable_filename
      }, () => {
        scrollToLine.invalidate()
        if (refreshEnhancedBlocks) {
          this.schedulePostRender(renderVersion, markdownRenderer, options)
        }
        refreshScroll()
      })
    }

    const refreshRender = (deferRender) => {
      Promise.all([
        this.loadMarkdownRenderer(),
        loadRenderDependencies(newContent),
        refreshHighlightedBlocks ? this.loadHighlighter() : Promise.resolve(null)
      ])
        .then(([markdownRenderer, , highlighter]) => {
          if (renderVersion !== this.renderVersion) {
            return
          }
          const usesHighlighter = Boolean(highlighter)
          if (!this.md || (usesHighlighter && !this.mdUsesHighlighter)) {
            this.md = markdownRenderer.createMarkdownRenderer(options, highlighter)
            this.mdUsesHighlighter = usesHighlighter
          }
          const renderWork = () => {
            applyRender(markdownRenderer, this.md.render(newContent))
          }
          if (deferRender) {
            this.scheduleIdleRender(renderVersion, renderWork)
          } else {
            renderWork()
          }
        })
        .catch((error) => {
          console.error(error)
        })
    }

    if (isInitialContent) {
      refreshRender(false)
      return
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      refreshRender(true)
    }, 16);
  }

  render() {
    const {
      theme,
      content,
      name,
      pageTitle,
      themeModeIsVisible,
      contentEditable,
      disableFilename,
    } = this.state

    return (
      <React.Fragment>
        <Head>
          <title>{(pageTitle || '').replace(/\$\{name\}/, name)}</title>
          <link rel="shortcut icon" type="image/ico" href="/_static/favicon.ico" />
          <link rel="stylesheet" href="/_static/page.css" />
          <link rel="stylesheet" href="/_static/markdown.css" />
          <link rel="stylesheet" href="/_static/admonition.css" />
          <link rel="stylesheet" href="/_static/highlight.css" />
          <link rel="stylesheet" href="/_static/sequence-diagram-min.css" />
        </Head>
        <main data-theme={this.state.theme}>
          <div id="page-ctn" contentEditable={contentEditable ? 'true' : 'false'}>
            { disableFilename == 0 &&
              <header
                id="page-header"
                onMouseEnter={this.showThemeButton}
                onMouseLeave={this.hideThemeButton}
              >
                <h3>
                  <svg
                    viewBox="0 0 16 16"
                    version="1.1"
                    width="16"
                    height="16"
                    aria-hidden="true"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M3 5h4v1H3V5zm0 3h4V7H3v1zm0 2h4V9H3v1zm11-5h-4v1h4V5zm0 2h-4v1h4V7zm0 2h-4v1h4V9zm2-6v9c0 .55-.45 1-1 1H9.5l-1 1-1-1H2c-.55 0-1-.45-1-1V3c0-.55.45-1 1-1h5.5l1 1 1-1H15c.55 0 1 .45 1 1zm-8 .5L7.5 3H2v9h6V3.5zm7-.5H9.5l-.5.5V12h6V3z"
                    >
                    </path>
                  </svg>
                  {name}
                </h3>
                {themeModeIsVisible && (
                  <label id="toggle-theme" for="theme">
                    <input
                      id="theme"
                      type="checkbox"
                      checked={theme === "dark"}
                      onChange={this.handleThemeChange}
                    />
                    <span>Dark Mode</span>
                  </label>
               )}
              </header>
            }
            <section
              className="markdown-body"
              dangerouslySetInnerHTML={{
                __html: content
              }}
            />
          </div>
        </main>
      </React.Fragment>
    )
  }
}
