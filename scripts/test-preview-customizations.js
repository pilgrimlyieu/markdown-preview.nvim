const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const MarkdownIt = require('markdown-it')
const markdownAdmonition = require('markdown-it-admon')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

function builtJsFiles () {
  const staticRoot = path.join(root, 'app', 'out', '_next', 'static')
  const files = []

  function walk (dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(file)
      } else if (file.endsWith('.js')) {
        files.push(file)
      }
    })
  }

  walk(staticRoot)
  return files
}

function builtPageBundlePath () {
  return builtJsFiles().find((candidate) =>
    candidate.endsWith(path.join('pages', 'index.js'))
  )
}

function builtBundles () {
  return builtJsFiles().map((file) => ({
    file,
    source: fs.readFileSync(file, 'utf8'),
    size: fs.statSync(file).size
  }))
}

function testAdmonitionRendering () {
  const md = new MarkdownIt({ html: true }).use(markdownAdmonition)

  const rendered = md.render([
    '!!! info Fingerprinting 的形式化定义',
    '    一个 fingerprinting 方案。',
    '    - 无假阴性',
    ''
  ].join('\n'))

  assert.match(rendered, /<div class="admonition info">/)
  assert.match(rendered, /<p class="admonition-title">Fingerprinting 的形式化定义<\/p>/)
  assert.match(rendered, /一个 fingerprinting 方案。/)
  assert.match(rendered, /<li>无假阴性<\/li>/)

  const emptyTitle = md.render([
    '!!! warning ""',
    '    empty title should not render quotes',
    ''
  ].join('\n'))

  assert.match(emptyTitle, /<div class="admonition warning">/)
  assert.doesNotMatch(emptyTitle, /admonition-title/)
  assert.doesNotMatch(emptyTitle, /&quot;&quot;|""/)
}

function testChartFenceRendering () {
  const source = read('app', 'pages', 'chart.js')
    .replace(
      /export\s+\{\s*chartPlugin\s*\}\s*export default\s+\{\s*chartPlugin\s*\}/s,
      'module.exports = { chartPlugin }'
    )
  const context = { module: { exports: {} } }
  vm.runInNewContext(source, context)

  const md = new MarkdownIt().use(context.module.exports.chartPlugin)
  const rendered = md.render([
    '```chart',
    '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}',
    '```',
    ''
  ].join('\n'))

  assert.match(rendered, /<canvas class="chartjs">/)
  assert.match(rendered, /"type":"bar"/)
}

function testRenderErrorUsesTextContent () {
  const source = read('app', 'pages', 'utils.js')
    .replace('export const escape', 'const escape')
    .replace('export const replaceWithRenderError', 'const replaceWithRenderError') +
    '\nmodule.exports = { replaceWithRenderError }\n'

  const created = []
  const replaced = []
  const context = {
    module: { exports: {} },
    document: {
      createElement: (tag) => {
        const element = { tag, textContent: '' }
        created.push(element)
        return element
      }
    }
  }
  const element = {
    replaceWith: (replacement) => {
      replaced.push(replacement)
    }
  }

  vm.runInNewContext(source, context)
  context.module.exports.replaceWithRenderError(element, 'Chart.js', '<img src=x>')

  assert.strictEqual(created.length, 1)
  assert.strictEqual(created[0].tag, 'pre')
  assert.strictEqual(created[0].textContent, 'Chart.js complains: "<img src=x>"')
  assert.strictEqual(replaced[0], created[0])
}

function testKatexStaticRuntime () {
  const staticContext = {}
  staticContext.window = staticContext
  staticContext.self = staticContext
  staticContext.globalThis = staticContext
  vm.runInNewContext(read('app', '_static', 'katex@0.15.3.js'), staticContext)
  vm.runInNewContext(read('app', '_static', 'mhchem.min.js'), staticContext)

  const source = read('app', 'pages', 'katex.js')
    .replace('export default function math_plugin', 'module.exports = function math_plugin')
  const context = {
    module: { exports: {} },
    console,
    katex: staticContext.katex
  }
  vm.runInNewContext(source, context)

  const md = new MarkdownIt().use(context.module.exports, { throwOnError: false })
  assert.match(md.render('$x^2$'), /class="katex"/)
  assert.match(md.render('$\\ce{H2O}$'), /mathvariant="normal">H/)
}

function testPlantumlPlaceholderRendering () {
  const codeUmlSource = read('app', 'pages', 'plantuml.js')
    .replace('export default', 'module.exports =')
  const plantumlRequire = (id) =>
    id === './plantuml-placeholder'
      ? require(path.join(root, 'app', 'pages', 'plantuml-placeholder.js'))
      : require(id)
  const context = {
    module: { exports: {} },
    console,
    require: plantumlRequire
  }
  vm.runInNewContext(codeUmlSource, context)

  const blockUml = require(path.join(root, 'app', 'pages', 'blockPlantuml.js'))
  const md = new MarkdownIt()
    .use(blockUml)
    .use(context.module.exports)

  const block = md.render([
    '@startuml',
    'Alice -> Bob',
    '@enduml',
    ''
  ].join('\n'))
  const fenced = md.render([
    '```plantuml',
    'Bob -> Alice',
    '```',
    ''
  ].join('\n'))

  assert.match(block, /class="plantuml-diagram"/)
  assert.match(block, /data-server="https:\/\/www\.plantuml\.com\/plantuml"/)
  assert.match(block, /Alice -&gt; Bob/)
  assert.match(fenced, /class="plantuml-diagram"/)
  assert.match(fenced, /Bob -&gt; Alice/)
  assert.doesNotMatch(block + fenced, /plantuml\/img\/[A-Za-z0-9_-]+/)
}

function testPlantumlRendererRuntime () {
  const plantumlEncoder = require('plantuml-encoder')
  const source = read('app', 'pages', 'plantuml-renderer.js')
    .replace("import plantumlEncoder from 'plantuml-encoder'", "const plantumlEncoder = require('plantuml-encoder')")
    .replace("import { replaceWithRenderError } from './utils'", "const replaceWithRenderError = () => { throw new Error('unexpected PlantUML render error') }")
    .replace('export default function renderPlantumlBlocks', 'module.exports = function renderPlantumlBlocks')
  const images = []
  const element = {
    textContent: 'Alice -> Bob',
    getAttribute: (name) => ({
      'data-image-format': 'svg',
      'data-server': 'https://example.test/plantuml',
      'data-alt': 'sequence'
    })[name],
    replaceWith: (image) => {
      images.push(image)
    }
  }
  const context = {
    module: { exports: {} },
    require,
    document: {
      querySelectorAll: (selector) => {
        assert.strictEqual(selector, '.plantuml-diagram')
        return [element]
      },
      createElement: (tag) => {
        assert.strictEqual(tag, 'img')
        return {}
      }
    }
  }

  vm.runInNewContext(source, context)
  context.module.exports()

  assert.strictEqual(images.length, 1)
  assert.strictEqual(images[0].alt, 'sequence')
  assert.strictEqual(
    images[0].src,
    `https://example.test/plantuml/svg/${plantumlEncoder.encode('Alice -> Bob')}`
  )
}

function testNativePreviewSocketRuntime () {
  const source = read('app', 'pages', 'preview-socket.js')
    .replace('export default function createPreviewSocket', 'module.exports = function createPreviewSocket')
  const instances = []
  const refreshes = []
  let timeoutScheduled = false

  function FakeWebSocket (url) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    instances.push(this)
  }
  FakeWebSocket.OPEN = 1
  FakeWebSocket.prototype.close = function () {
    this.readyState = 3
  }

  const context = {
    module: { exports: {} },
    console,
    WebSocket: FakeWebSocket,
    window: {
      location: {
        protocol: 'http:',
        host: 'localhost:18282'
      }
    },
    setTimeout: () => {
      timeoutScheduled = true
      return 1
    },
    clearTimeout: () => {}
  }

  vm.runInNewContext(source, context)
  const socket = context.module.exports(12)
  socket.on('refresh_content', (data) => refreshes.push(data))

  assert.strictEqual(instances[0].url, 'ws://localhost:18282/ws?bufnr=12')
  instances[0].onmessage({
    data: JSON.stringify({
      event: 'refresh_content',
      data: { len: 1258 }
    })
  })
  assert.deepStrictEqual(refreshes, [{ len: 1258 }])

  socket.close()
  instances[0].onclose()
  assert.strictEqual(timeoutScheduled, false)
}

function testNativePreviewSocketIgnoresStaleEvents () {
  const source = read('app', 'pages', 'preview-socket.js')
    .replace('export default function createPreviewSocket', 'module.exports = function createPreviewSocket')
  const instances = []
  let reconnect = null

  function FakeWebSocket (url) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    this.closeCount = 0
    instances.push(this)
  }
  FakeWebSocket.OPEN = 1
  FakeWebSocket.prototype.close = function () {
    this.closeCount += 1
    this.readyState = 3
  }

  const context = {
    module: { exports: {} },
    console,
    WebSocket: FakeWebSocket,
    window: {
      location: {
        protocol: 'http:',
        host: 'localhost:18282'
      }
    },
    setTimeout: (callback, delay) => {
      assert.strictEqual(delay, 500)
      reconnect = callback
      return 1
    },
    clearTimeout: () => {}
  }

  vm.runInNewContext(source, context)
  context.module.exports(12)
  instances[0].onclose()
  assert.ok(reconnect, 'expected reconnect after unexpected close')

  reconnect()
  assert.strictEqual(instances.length, 2)

  instances[0].onerror()
  assert.strictEqual(instances[0].closeCount, 1)
  assert.strictEqual(instances[1].closeCount, 0)
}

function testHighlightLanguageSubset () {
  const page = read('app', 'pages', 'index.jsx')
  const markdownRenderer = read('app', 'pages', 'markdown-renderer.js')
  assert.doesNotMatch(page, /import hljs from '\.\/highlight'/)
  assert.match(markdownRenderer, /import hljs from '\.\/highlight'/)
  assert.doesNotMatch(page, /from 'highlight\.js'/)

  const highlighter = read('app', 'pages', 'highlight.js')
  assert.match(highlighter, /from 'highlight\.js\/lib\/core'/)
  assert.doesNotMatch(highlighter, /from 'highlight\.js'|require\(['"]highlight\.js['"]\)/)
  ;[
    'java',
    'python',
    'c',
    'cpp',
    'sql',
    'pgsql',
    'bash',
    'shell',
    'xml',
    'yaml',
    'markdown',
    'latex',
    'x86asm',
    'mipsasm',
    'plaintext'
  ].forEach((language) => {
    assert.match(highlighter, new RegExp(`highlight\\.js/lib/languages/${language}`))
  })
  assert.match(highlighter, /registerAliases\(\['assembly', 'asm'\], \{ languageName: 'x86asm' \}\)/)
  assert.match(highlighter, /registerAliases\('mips', \{ languageName: 'mipsasm' \}\)/)
}

function testHighlightRuntimeSubset () {
  const source = read('app', 'pages', 'highlight.js')
    .replace(/import ([a-zA-Z0-9_]+) from '([^']+)'/g, "const $1 = require('$2')")
    .replace('export default hljs', 'module.exports = hljs')
  const context = {
    module: { exports: {} },
    require
  }

  vm.runInNewContext(source, context)
  const hljs = context.module.exports

  assert.ok(hljs.getLanguage('java'), 'expected Java highlighting')
  assert.ok(hljs.getLanguage('python'), 'expected Python highlighting')
  assert.ok(hljs.getLanguage('assembly'), 'expected assembly alias')
  assert.ok(hljs.getLanguage('mips'), 'expected MIPS alias')
  assert.strictEqual(hljs.getLanguage('accesslog'), undefined)

  const highlighted = hljs.highlight('java', 'public class A {}', true).value
  assert.match(highlighted, /hljs-keyword/)
}

function testScrollSource () {
  const scrollSource = read('app', 'pages', 'scroll.js')

  assert.doesNotMatch(scrollSource, /\.offsetTop\b/)
  assert.doesNotMatch(scrollSource, /querySelector\(`/)
  assert.doesNotMatch(scrollSource, /TweenLite|Power2/)
  assert.match(scrollSource, /requestAnimationFrame/)
  assert.match(scrollSource, /function scheduleScroll/)
}

function testScrollRuntimeUsesDocumentOffset () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  const scrollCalls = []
  const lineElement = {
    offsetTop: 0,
    getAttribute: () => '12',
    getBoundingClientRect: () => ({ top: 900 })
  }

  const context = {
    module: { exports: {} },
    window: {
      pageYOffset: 300,
      scrollTo: (options) => {
        scrollCalls.push(options)
      }
    },
    document: {
      body: { scrollTop: 300 },
      documentElement: {
        scrollTop: 300,
        clientHeight: 600,
        scrollHeight: 2400
      },
      querySelectorAll: () => [lineElement]
    }
  }

  vm.runInNewContext(source, context)
  context.module.exports.relative({
    cursor: 13,
    winline: 5,
    winheight: 10,
    len: 100
  })

  assert.deepStrictEqual(scrollCalls, [{ top: 900, behavior: 'smooth' }])
}

function testScrollRuntimeInterpolatesIndentedAdmonitionBody () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  const scrollCalls = []
  const anchors = [
    {
      getAttribute: () => '35',
      getBoundingClientRect: () => ({ top: 900 })
    },
    {
      getAttribute: () => '37',
      getBoundingClientRect: () => ({ top: 1100 })
    }
  ]

  const context = {
    module: { exports: {} },
    window: {
      pageYOffset: 300,
      scrollTo: (options) => {
        scrollCalls.push(options)
      }
    },
    document: {
      body: { scrollTop: 300 },
      documentElement: {
        scrollTop: 300,
        clientHeight: 600,
        scrollHeight: 2400
      },
      querySelectorAll: () => anchors
    }
  }

  vm.runInNewContext(source, context)
  context.module.exports.middle({
    cursor: 37,
    len: 1258
  })

  assert.deepStrictEqual(scrollCalls, [{ top: 1000, behavior: 'smooth' }])
}

function testScrollRuntimeCachesSourceLineAnchors () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  let queryCount = 0
  const scrollCalls = []
  const anchors = [
    {
      getAttribute: () => '10',
      getBoundingClientRect: () => ({ top: 100 })
    },
    {
      getAttribute: () => '20',
      getBoundingClientRect: () => ({ top: 300 })
    }
  ]

  const context = {
    module: { exports: {} },
    window: {
      pageYOffset: 0,
      scrollTo: (options) => {
        scrollCalls.push(options)
      }
    },
    document: {
      body: { scrollTop: 0 },
      documentElement: {
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 1000
      },
      querySelectorAll: () => {
        queryCount += 1
        return anchors
      }
    }
  }

  vm.runInNewContext(source, context)
  context.module.exports.middle({
    cursor: 16,
    len: 100
  })
  context.module.exports.middle({
    cursor: 16,
    len: 100
  })

  assert.strictEqual(queryCount, 1)
  assert.deepStrictEqual(scrollCalls, [
    { top: 150, behavior: 'smooth' },
    { top: 150, behavior: 'smooth' }
  ])

  context.module.exports.invalidate()
  context.module.exports.middle({
    cursor: 16,
    len: 100
  })

  assert.strictEqual(queryCount, 2)
}

function testScrollRuntimeCoalescesAnimationFrame () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  const frames = []
  const scrollCalls = []
  const anchors = [
    {
      getAttribute: () => '10',
      getBoundingClientRect: () => ({ top: 100 })
    },
    {
      getAttribute: () => '20',
      getBoundingClientRect: () => ({ top: 300 })
    }
  ]

  const context = {
    module: { exports: {} },
    window: {
      pageYOffset: 0,
      requestAnimationFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      scrollTo: (options) => {
        scrollCalls.push(options)
      }
    },
    document: {
      body: { scrollTop: 0 },
      documentElement: {
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 1000
      },
      querySelectorAll: () => anchors
    }
  }

  vm.runInNewContext(source, context)
  context.module.exports.middle({
    cursor: 11,
    len: 100
  })
  context.module.exports.middle({
    cursor: 21,
    len: 100
  })

  assert.strictEqual(frames.length, 1)
  assert.deepStrictEqual(scrollCalls, [])

  frames.shift()()
  assert.deepStrictEqual(scrollCalls, [{ top: 250, behavior: 'smooth' }])

  context.module.exports.middle({
    cursor: 11,
    len: 100
  })
  context.module.exports.invalidate()
  frames.shift()()
  assert.strictEqual(scrollCalls.length, 1)
}

function loadPreviewPageForTest ({ idleCallbacks = false, fakeTimers = false } = {}) {
  process.env.BROWSERSLIST_IGNORE_OLD_DATA = '1'

  const babel = require('@babel/core')
  const source = read('app', 'pages', 'index.jsx')
  const code = babel.transformSync(source, {
    presets: ['next/babel'],
    babelrc: false,
    configFile: false,
    filename: 'index.jsx'
  }).code.replace(
    /import\((['"]\.\/markdown-renderer['"])\)/g,
    'Promise.resolve(require($1))'
  )

  const scripts = []
  const styles = []
  const scrollCalls = []
  const renderCalls = []
  const idleQueue = new Map()
  const timerQueue = new Map()
  let idleId = 1
  let timerId = 1
  const noopPlugin = () => {}
  class FakeMarkdownIt {
    use () {
      return this
    }

    render (content) {
      renderCalls.push(content)
      return `<p>${content}</p>`
    }
  }

  const fakeReact = {
    Fragment: 'Fragment',
    createElement: () => ({}),
    Component: class {
      constructor () {
        this.state = {}
      }

      setState (update, callback) {
        const patch = typeof update === 'function' ? update(this.state) : update
        this.state = { ...this.state, ...patch }
        if (callback) {
          callback()
        }
      }
    }
  }

  const fakeScroll = {
    invalidate: () => scrollCalls.push({ type: 'invalidate' }),
    middle: (payload) => scrollCalls.push({ type: 'middle', ...payload }),
    relative: (payload) => scrollCalls.push({ type: 'relative', ...payload }),
    top: (payload) => scrollCalls.push({ type: 'top', ...payload })
  }

  const defaultModule = (value) => ({ __esModule: true, default: value })
  const pluginModule = defaultModule(noopPlugin)
  const stubModules = {
    react: fakeReact,
    'next/head': defaultModule(() => null),
    './markdown-renderer': {
      __esModule: true,
      createMarkdownRenderer: () => new FakeMarkdownIt(),
      renderDiagram: noopPlugin,
      renderFlowchart: noopPlugin,
      renderDot: noopPlugin
    },
    './preview-socket': defaultModule(() => ({ on: noopPlugin, close: noopPlugin })),
    './scroll': defaultModule(fakeScroll)
  }
  const requireStub = (id) => {
    if (stubModules[id]) {
      return stubModules[id]
    }
    if (id.startsWith('./') || id.startsWith('markdown-it')) {
      return pluginModule
    }
    return require(id)
  }

  const windowStub = {
    history: { replaceState: noopPlugin },
    location: {
      pathname: '/page/1',
      protocol: 'http:',
      host: 'localhost:23720'
    },
    matchMedia: () => ({ matches: false }),
    close: noopPlugin
  }

  if (idleCallbacks) {
    windowStub.requestIdleCallback = (callback) => {
      const id = idleId
      idleId += 1
      idleQueue.set(id, callback)
      return id
    }
    windowStub.cancelIdleCallback = (id) => {
      idleQueue.delete(id)
    }
  }

  const setTimer = fakeTimers
    ? (callback) => {
        const id = timerId
        timerId += 1
        timerQueue.set(id, callback)
        return id
      }
    : setTimeout
  const clearTimer = fakeTimers
    ? (id) => {
        timerQueue.delete(id)
      }
    : clearTimeout

  const module = { exports: {} }
  const context = {
    module,
    exports: module.exports,
    require: requireStub,
    console,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    Promise,
    window: windowStub,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => ({
        tag,
        src: '',
        onload: null,
        onerror: null,
        remove: noopPlugin
      }),
      head: {
        appendChild: (element) => {
          if (element.tag === 'link') {
            styles.push(element)
          } else {
            scripts.push(element)
          }
        }
      }
    }
  }

  vm.runInNewContext(code, context)

  return {
    PreviewPage: module.exports.default,
    scripts,
    styles,
    scrollCalls,
    renderCalls,
    runIdleCallbacks: () => {
      for (const [id, callback] of Array.from(idleQueue.entries())) {
        idleQueue.delete(id)
        callback({ didTimeout: false, timeRemaining: () => 50 })
      }
    },
    pendingIdleCallbacks: () => idleQueue.size,
    runTimers: () => {
      for (const [id, callback] of Array.from(timerQueue.entries())) {
        timerQueue.delete(id)
        callback()
      }
    },
    pendingTimers: () => timerQueue.size
  }
}

async function flushPromises () {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function testAsyncMathRenderUsesLatestScrollPayload () {
  const { PreviewPage, scripts, styles, scrollCalls } = loadPreviewPageForTest()
  const page = new PreviewPage({})

  page.onRefreshContent({
    options: { sync_scroll_type: 'middle' },
    isActive: true,
    winline: 1,
    winheight: 20,
    cursor: [0, 1, 1, 0],
    pageTitle: '',
    theme: 'light',
    name: '/tmp/math.md',
    content: ['# Math', '$x^2$']
  })

  await flushPromises()
  assert.strictEqual(scripts.length, 1)
  assert.strictEqual(scripts[0].src, '/_static/katex@0.15.3.js')
  assert.strictEqual(styles.length, 1)
  assert.strictEqual(styles[0].href, '/_static/katex@0.15.3.css')
  assert.strictEqual(page.state.content, '')

  page.onSyncScroll({
    options: { sync_scroll_type: 'middle' },
    isActive: true,
    winline: 10,
    winheight: 20,
    cursor: [0, 36, 1, 0],
    len: 100
  })
  assert.strictEqual(scrollCalls[scrollCalls.length - 1].cursor, 36)

  styles[0].onload()
  scripts[0].onload()
  await flushPromises()

  assert.match(page.state.content, /\$x\^2\$/)
  assert.strictEqual(page.state.cursor[1], 36)
  assert.strictEqual(scrollCalls[scrollCalls.length - 1].cursor, 36)
}

async function testFollowupRenderWaitsForIdleAndCancelsStaleWork () {
  const {
    PreviewPage,
    renderCalls,
    runIdleCallbacks,
    pendingIdleCallbacks,
    runTimers,
    pendingTimers
  } = loadPreviewPageForTest({ idleCallbacks: true, fakeTimers: true })
  const page = new PreviewPage({})

  const refresh = (line, content) => page.onRefreshContent({
    options: { sync_scroll_type: 'middle' },
    isActive: true,
    winline: 1,
    winheight: 20,
    cursor: [0, line, 1, 0],
    pageTitle: '',
    theme: 'light',
    name: '/tmp/idle.md',
    content: [content]
  })

  refresh(1, '# Initial')
  await flushPromises()
  assert.strictEqual(page.state.content, '<p># Initial</p>')
  assert.deepStrictEqual(renderCalls, ['# Initial'])

  refresh(2, '# Stale')
  assert.strictEqual(pendingTimers(), 1)
  assert.strictEqual(pendingIdleCallbacks(), 0)
  runTimers()
  await flushPromises()
  assert.strictEqual(page.state.content, '<p># Initial</p>')
  assert.strictEqual(pendingTimers(), 0)
  assert.strictEqual(pendingIdleCallbacks(), 1)

  refresh(3, '# Latest')
  assert.strictEqual(pendingTimers(), 1)
  assert.strictEqual(pendingIdleCallbacks(), 0)
  runTimers()
  await flushPromises()
  assert.strictEqual(pendingTimers(), 0)
  assert.strictEqual(pendingIdleCallbacks(), 1)

  runIdleCallbacks()
  await flushPromises()
  assert.strictEqual(page.state.content, '<p># Latest</p>')
  assert.deepStrictEqual(renderCalls, ['# Initial', '# Latest'])
}

async function testPlainMarkdownSkipsMathAssets () {
  const { PreviewPage, scripts, styles } = loadPreviewPageForTest()
  const page = new PreviewPage({})

  page.onRefreshContent({
    options: { sync_scroll_type: 'middle' },
    isActive: true,
    winline: 1,
    winheight: 20,
    cursor: [0, 1, 1, 0],
    pageTitle: '',
    theme: 'light',
    name: '/tmp/plain.md',
    content: ['# Plain', 'No math here.']
  })

  await flushPromises()

  assert.strictEqual(scripts.length, 0)
  assert.strictEqual(styles.length, 0)
  assert.match(page.state.content, /No math here\./)
}

function testBuiltPreviewBundle () {
  const html = read('app', 'out', 'index.html')
  assert.match(html, /\/_static\/admonition\.css/)
  assert.doesNotMatch(html, /\/_static\/katex@0\.15\.3\.css/)
  assert.doesNotMatch(html, /<script[^>]+\/_static\/katex@0\.15\.3\.js/)
  assert.doesNotMatch(html, /<script[^>]+\/_static\/mhchem\.min\.js/)

  const pageBundle = builtPageBundlePath()
  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundles = builtBundles()
  const page = bundles.find((bundle) => bundle.file === pageBundle)
  const rendererChunk = bundles.find((bundle) =>
    bundle.file !== pageBundle &&
    /admonition-title/.test(bundle.source) &&
    /math_inline/.test(bundle.source)
  )

  assert.ok(page, 'expected built page bundle')
  assert.match(page.source, /getBoundingClientRect\(\)\.top/)
  assert.match(page.source, /admonition\.css/)
  assert.doesNotMatch(page.source, /admonition-title|math_inline|markdown-it-anchor|markdown-it-toc-done-right/)
  assert.doesNotMatch(page.source, /TweenLite\.to|Power2\.easeOut/)
  assert.doesNotMatch(page.source, /Chart\.js v2\./)
  assert.doesNotMatch(page.source, /pako|deflate/)
  assert.doesNotMatch(page.source, /socket\.io|engine\.io|parseqs|socket\.io-parser/)
  assert.doesNotMatch(page.source, /accesslog/)
  assert.ok(rendererChunk, 'expected markdown renderer to be emitted into a lazy chunk')
  assert.ok(
    page.size < 100000,
    `expected lean preview page bundle after renderer splitting, got ${page.size}`
  )
}

function testRuntimeSelection () {
  const rpc = read('autoload', 'mkdp', 'rpc.vim')
  const bunIndex = rpc.indexOf("executable('bun')")
  const nodeIndex = rpc.indexOf("executable('node')")

  assert.ok(bunIndex > -1, 'expected Bun runtime branch')
  assert.ok(nodeIndex > -1, 'expected Node runtime fallback branch')
  assert.ok(bunIndex < nodeIndex, 'expected Bun to be tried before Node')
}

function testMultiPortSupport () {
  const plugin = read('plugin', 'mkdp.vim')
  assert.match(plugin, /g:mkdp_port_range/)
  assert.match(plugin, /g:mkdp_multi_port/)

  const rpc = read('autoload', 'mkdp', 'rpc.vim')
  assert.match(rpc, /let s:servers = {}/)
  assert.match(rpc, /function! s:server_key/)
  assert.match(rpc, /MKDP_START_BUFNR/)
  assert.match(rpc, /function! mkdp#rpc#start_server\(\.\.\.\)/)
  assert.match(rpc, /function! mkdp#rpc#stop_server\(\.\.\.\)/)
  assert.match(rpc, /function! mkdp#rpc#open_browser\(\.\.\.\)/)
  assert.match(rpc, /call ch_sendraw\(a:clientId, data\."\\n"\)/)

  const util = read('autoload', 'mkdp', 'util.vim')
  assert.match(util, /function! mkdp#util#open_browser\(\.\.\.\)/)
  assert.match(util, /mkdp#rpc#open_browser\(l:bufnr\)/)
  assert.match(util, /get\(g:, 'mkdp_multi_port', 0\)/)
  assert.match(util, /mkdp#rpc#stop_server\(bufnr\('%'\)\)/)
  assert.match(util, /mkdp#rpc#stop_server\(\)/)
  assert.match(util, /let b:MarkdownPreviewToggleBool = 0/)
  assert.doesNotMatch(util, /try_ids/)
  assert.doesNotMatch(util, /try_open_preview_page/)
  assert.doesNotMatch(util, /server_status ==# 0/)

  const server = read('app', 'server.js')
  assert.match(server, /function startServer/)
  assert.match(server, /require\('net'\)/)
  assert.match(server, /process\.env\.MKDP_START_BUFNR/)
  assert.match(server, /listenOnAvailablePort/)
  assert.match(server, /normalizePortRange/)
  assert.match(server, /isPortUnavailableError/)
  assert.match(server, /checkPortAvailable/)
  assert.match(server, /probe\.listen\(\{ host, port \}\)/)
  assert.match(server, /port \\d\+ \.\*in use/)
  assert.match(server, /EADDRINUSE/)
  assert.match(server, /EACCES/)
  assert.match(server, /const emitToClients = \(bufnr, event, data\)/)
  assert.match(server, /const closeClients = \(bufnr\)/)
  assert.match(server, /clients\[bufnr\] = \(clients\[bufnr\] \|\| \[\]\)\.filter\(c => c\.id !== client\.id\)/)
  assert.doesNotMatch(server, /map\(c => c\.id !== client\.id\)/)
  assert.match(server, /const url = `http:\/\/\$\{openHost\}:\$\{port\}\/page\/\$\{bufnr\}`/)
  assert.match(server, /mkdp#util#open_browser', \[startBufnr\]/)
}

function testNativePreviewTransport () {
  const page = read('app', 'pages', 'index.jsx')
  assert.match(page, /import createPreviewSocket from '\.\/preview-socket'/)
  assert.match(page, /const socket = createPreviewSocket\(bufnr\)/)
  assert.doesNotMatch(page, /socket\.io-client|\bio\(/)

  const previewSocket = read('app', 'pages', 'preview-socket.js')
  assert.match(previewSocket, /new WebSocket\(socketUrl\(bufnr\)\)/)
  assert.match(previewSocket, /\/ws\?bufnr=/)
  assert.match(previewSocket, /JSON\.parse\(event\.data\)/)
  assert.match(previewSocket, /setTimeout\(connect, reconnectDelay\)/)

  const server = read('app', 'server.js')
  assert.match(server, /const WebSocket = require\('ws'\)/)
  assert.match(server, /new WebSocket\.Server\(\{/)
  assert.match(server, /path: '\/ws'/)
  assert.match(server, /client\.send\(JSON\.stringify\(\{ event, data \}\)\)/)
  assert.doesNotMatch(server, /socket\.io|client\.emit\(/)

  const preload = read('src', 'app', 'preloadmodules.ts')
  assert.match(preload, /const ws = require\('ws'\)/)
  assert.doesNotMatch(preload, /socket\.io/)

  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.dependencies.ws, 'expected ws dependency')
  assert.strictEqual(pkg.dependencies['socket.io'], undefined)
  assert.strictEqual(pkg.dependencies['socket.io-client'], undefined)

  const appPkg = JSON.parse(read('app', 'package.json'))
  assert.ok(appPkg.dependencies.ws, 'expected app ws dependency')
  assert.strictEqual(appPkg.dependencies['socket.io'], undefined)
}

function testCursorSyncUsesLightweightEvent () {
  const plugin = read('plugin', 'mkdp.vim')
  assert.match(plugin, /g:mkdp_sync_scroll_on_cursor/)
  assert.match(plugin, /g:mkdp_sync_scroll_throttle/)

  const autocmd = read('autoload', 'mkdp', 'autocmd.vim')
  assert.match(autocmd, /CursorMoved,CursorMovedI <buffer> call mkdp#rpc#preview_sync_scroll\(\)/)
  assert.doesNotMatch(autocmd, /CursorMoved[^\n]*preview_refresh/)

  const rpc = read('autoload', 'mkdp', 'rpc.vim')
  assert.match(rpc, /let s:sync_scroll_timers = {}/)
  assert.match(rpc, /function! s:sync_scroll_throttle\(\)/)
  assert.match(rpc, /function! s:clear_sync_scroll_timer\(bufnr\)/)
  assert.match(rpc, /function! s:clear_all_sync_scroll_timers\(\)/)
  assert.match(rpc, /for l:key in keys\(copy\(s:sync_scroll_timers\)\)/)
  assert.match(rpc, /timer_stop\(s:sync_scroll_timers\[l:key\]\)/)
  assert.match(rpc, /remove\(s:sync_scroll_timers, l:key\)/)
  assert.match(rpc, /call s:clear_all_sync_scroll_timers\(\)/)
  assert.match(rpc, /function! s:sync_scroll_data\(bufnr\)/)
  assert.match(rpc, /'winline': winline\(\)/)
  assert.match(rpc, /'winheight': winheight\(0\)/)
  assert.match(rpc, /'cursor': getpos\('\.'\)/)
  assert.match(rpc, /'len': line\('\$'\)/)
  assert.match(rpc, /s:notify_server\(a:bufnr, 'sync_scroll', s:sync_scroll_data\(a:bufnr\)\)/)
  assert.match(rpc, /timer_start\(l:delay, function\('s:send_sync_scroll', \[l:bufnr\]\)\)/)
  assert.match(rpc, /function! mkdp#rpc#preview_sync_scroll\(\)/)
  assert.match(rpc, /'sync_scroll'/)

  const attach = read('src', 'attach', 'index.ts')
  assert.match(attach, /const getScrollData = async/)
  assert.match(attach, /method === 'sync_scroll' && opts\.data/)
  assert.ok(
    attach.indexOf("method === 'sync_scroll' && opts.data") < attach.indexOf('const buffer = await findBuffer(bufnr)'),
    'expected precomputed sync scroll payload to avoid buffer lookup'
  )
  assert.match(attach, /method === 'refresh_content' \|\| method === 'sync_scroll'/)
  assert.match(attach, /app\.syncScroll/)
  assert.match(attach, /nvim\.call\('line', \['\$'\]\)/)

  const server = read('app', 'server.js')
  assert.match(server, /function syncScroll/)
  assert.match(server, /emitToClients\(bufnr, 'sync_scroll', data\)/)

  const page = read('app', 'pages', 'index.jsx')
  assert.match(page, /const IDLE_RENDER_TIMEOUT = 500/)
  assert.match(page, /requestIdleCallback\(callback, \{ timeout: IDLE_RENDER_TIMEOUT \}\)/)
  assert.match(page, /cancelIdleCallback\(id\)/)
  assert.match(page, /scheduleIdleRender\(renderVersion, renderWork\)/)
  assert.match(page, /socket\.on\('sync_scroll', this\.onSyncScroll\.bind\(this\)\)/)
  assert.match(page, /onSyncScroll\(scrollPayload\)/)
  assert.match(page, /this\.latestScroll = scrollPayload/)
  assert.match(page, /scrollToLine\[syncScrollType\] \|\| scrollToLine\.middle/)
  assert.match(page, /scrollToLine\.invalidate\(\)/)
  assert.match(page, /const refreshScroll = \(\) => this\.onSyncScroll\(this\.latestScroll \|\| scrollPayload\)/)
}

function testDebouncedContentRefresh () {
  const plugin = read('plugin', 'mkdp.vim')
  assert.match(plugin, /g:mkdp_refresh_debounce/)
  assert.match(plugin, /let g:mkdp_refresh_debounce = 160/)

  const autocmd = read('autoload', 'mkdp', 'autocmd.vim')
  assert.match(autocmd, /TextChanged,TextChangedI <buffer> call mkdp#rpc#preview_refresh_debounced\(\)/)
  assert.doesNotMatch(autocmd, /TextChanged[^\n]*preview_refresh\(\)/)

  const rpc = read('autoload', 'mkdp', 'rpc.vim')
  assert.match(rpc, /let s:refresh_timers = {}/)
  assert.match(rpc, /function! s:refresh_debounce\(\)/)
  assert.match(rpc, /get\(g:, 'mkdp_refresh_debounce', 160\)/)
  assert.match(rpc, /function! s:clear_refresh_timer\(bufnr\)/)
  assert.match(rpc, /function! s:clear_all_refresh_timers\(\)/)
  assert.match(rpc, /for l:key in keys\(copy\(s:refresh_timers\)\)/)
  assert.match(rpc, /timer_stop\(s:refresh_timers\[l:key\]\)/)
  assert.match(rpc, /remove\(s:refresh_timers, l:key\)/)
  assert.match(rpc, /call s:clear_all_refresh_timers\(\)/)
  assert.match(rpc, /function! s:send_refresh\(bufnr, \.\.\.\)/)
  assert.match(rpc, /s:notify_server\(a:bufnr, 'refresh_content', { 'bufnr': a:bufnr }\)/)
  assert.match(rpc, /function! mkdp#rpc#preview_refresh_debounced\(\)/)
  assert.match(rpc, /timer_start\(l:delay, function\('s:send_refresh', \[l:bufnr\]\)\)/)
  assert.match(rpc, /call s:clear_refresh_timer\(a:server\.bufnr\)/)
  assert.match(rpc, /call s:clear_refresh_timer\(l:bufnr\)/)

  const readme = read('README.md')
  assert.match(readme, /let g:mkdp_refresh_debounce = 160/)
}

function testHighFrequencyLogsAreDebugOnly () {
  const server = read('app', 'server.js')
  assert.match(server, /logger\.debug\('refresh page: ', bufnr\)/)
  assert.match(server, /logger\.debug\('sync scroll: ', bufnr\)/)
  assert.doesNotMatch(server, /logger\.info\('refresh page: '/)
  assert.doesNotMatch(server, /logger\.info\('sync scroll: '/)
  assert.match(server, /logger\.info\('server run: ', port\)/)

  const routes = read('app', 'routes.js')
  assert.match(routes, /logger\.debug\('image route: ', req\.asPath\)/)
  assert.match(routes, /logger\.debug\('fileDir', fileDir\)/)
  assert.match(routes, /logger\.debug\('imgPath', imgPath\)/)
  assert.doesNotMatch(routes, /logger\.info\('image route: '/)
  assert.doesNotMatch(routes, /logger\.info\('fileDir'/)
  assert.doesNotMatch(routes, /logger\.info\('imgPath'/)
}

function testFreshRefreshSkipsFullContent () {
  const attach = read('src', 'attach', 'index.ts')
  assert.match(attach, /const getChangedtick = \(bufnr/)
  assert.match(attach, /app\.isContentFresh\(\{ bufnr, changedtick \}\)/)
  assert.match(attach, /changedtick/)

  const freshnessCheck = attach.indexOf('app.isContentFresh')
  const fullContentRead = attach.indexOf('buffer.getLines()')
  const cursorSyncBranch = attach.indexOf("method === 'sync_scroll'")
  const changedtickRead = attach.indexOf('const changedtick = await getChangedtick(bufnr)')
  assert.ok(freshnessCheck > -1, 'expected freshness check in attach bridge')
  assert.ok(fullContentRead > -1, 'expected full content read in attach bridge')
  assert.ok(cursorSyncBranch > -1, 'expected cursor sync branch in attach bridge')
  assert.ok(changedtickRead > -1, 'expected changedtick read in attach bridge')
  assert.ok(cursorSyncBranch < changedtickRead, 'expected cursor sync to avoid changedtick RPC')
  assert.ok(freshnessCheck < fullContentRead, 'expected fresh content check before buffer.getLines()')

  const server = read('app', 'server.js')
  assert.match(server, /let contentTicks = {}/)
  assert.match(server, /const markContentFresh = \(\{ bufnr, changedtick \}\)/)
  assert.match(server, /const isContentFresh = \(\{ bufnr, changedtick \}\)/)
  assert.match(server, /changedtick = await plugin\.nvim\.call\('getbufvar'/)
  assert.match(server, /markContentFresh\(\{ bufnr, changedtick: data\.changedtick \}\)/)
}

function testSelectivePostRenderGates () {
  const page = read('app', 'pages', 'index.jsx')
  const markdownRenderer = read('app', 'pages', 'markdown-renderer.js')
  assert.match(page, /const hasElement = \(selector\) => document\.querySelector\(selector\) !== null/)
  assert.match(page, /import\('\.\/markdown-renderer'\)/)
  assert.doesNotMatch(page, /import MarkdownIt from 'markdown-it'/)
  assert.match(markdownRenderer, /import MarkdownIt from 'markdown-it'/)
  assert.match(markdownRenderer, /export function createMarkdownRenderer/)
  assert.match(page, /const mermaidNodes = document\.querySelectorAll\('\.mermaid'\)/)
  assert.match(page, /if \(!mermaidNodes\.length\) \{\n\s+return\n\s+\}/)
  assert.match(page, /if \(hasElement\('\.chartjs'\)\) \{\n\s+renderChart\(\)/)
  assert.match(page, /import\('\.\/chart-renderer'\)/)
  assert.match(page, /if \(hasElement\('\.plantuml-diagram'\)\) \{\n\s+renderPlantuml\(\)/)
  assert.match(page, /import\('\.\/plantuml-renderer'\)/)
  assert.match(page, /renderWithLazyScripts\(MERMAID_SCRIPTS/)
  assert.match(page, /renderWithLazyScripts\(SEQUENCE_DIAGRAM_SCRIPTS, markdownRenderer\.renderDiagram\)/)
  assert.match(page, /renderWithLazyScripts\(FLOWCHART_SCRIPTS, markdownRenderer\.renderFlowchart\)/)
  assert.match(page, /renderWithLazyScripts\(DOT_SCRIPTS, markdownRenderer\.renderDot\)/)

  const chartPlugin = read('app', 'pages', 'chart.js')
  assert.doesNotMatch(chartPlugin, /from 'chart\.js'|require\(['"]chart\.js['"]\)/)
  assert.match(chartPlugin, /const chartPlugin = \(md\) =>/)

  const chartRenderer = read('app', 'pages', 'chart-renderer.js')
  assert.match(chartRenderer, /from 'chart\.js'/)

  const blockPlantuml = read('app', 'pages', 'blockPlantuml.js')
  assert.doesNotMatch(blockPlantuml, /plantuml-encoder|pako/)

  const codePlantuml = read('app', 'pages', 'plantuml.js')
  assert.doesNotMatch(codePlantuml, /plantuml-encoder|pako/)

  const plantumlPlaceholder = read('app', 'pages', 'plantuml-placeholder.js')
  assert.doesNotMatch(plantumlPlaceholder, /plantuml-encoder|pako/)
  assert.match(plantumlPlaceholder, /function plantumlPlaceholder/)

  const plantumlRenderer = read('app', 'pages', 'plantuml-renderer.js')
  assert.match(plantumlRenderer, /from 'plantuml-encoder'/)

  const html = read('app', 'out', 'index.html')
  assert.doesNotMatch(html, /\/_static\/mermaid\.min\.js/)
  assert.doesNotMatch(html, /\/_static\/sequence-diagram-min\.js/)
  assert.doesNotMatch(html, /\/_static\/tweenlite\.min\.js/)
  assert.doesNotMatch(html, /\/_static\/flowchart@1\.13\.0\.min\.js/)
  assert.doesNotMatch(html, /\/_static\/full\.render\.js/)
  assert.doesNotMatch(html, /<script[^>]+\/_static\/katex@0\.15\.3\.js/)
  assert.doesNotMatch(html, /<script[^>]+\/_static\/mhchem\.min\.js/)
}

function testChartRendererIsLazyChunk () {
  const pageBundle = builtPageBundlePath()
  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundles = builtBundles()
  const page = bundles.find((bundle) => bundle.file === pageBundle)
  const asyncChartChunk = bundles.find((bundle) =>
    bundle.file !== pageBundle && /Chart\.js v2\./.test(bundle.source)
  )

  assert.ok(page, 'expected built page bundle')
  assert.doesNotMatch(page.source, /Chart\.js v2\./)
  assert.ok(asyncChartChunk, 'expected Chart.js to be emitted into a lazy chunk')
}

function testPlantumlRendererIsLazyChunk () {
  const pageBundle = builtPageBundlePath()
  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundles = builtBundles()
  const page = bundles.find((bundle) => bundle.file === pageBundle)
  const asyncPlantumlChunk = bundles.find((bundle) =>
    bundle.file !== pageBundle && /pako|deflate/.test(bundle.source)
  )

  assert.ok(page, 'expected built page bundle')
  assert.doesNotMatch(page.source, /pako|deflate/)
  assert.ok(asyncPlantumlChunk, 'expected PlantUML encoder to be emitted into a lazy chunk')
}

function testBunCompatibleModuleLoader () {
  const loader = path.join(root, 'app', 'lib', 'app', 'load.js')
  assert.ok(fs.existsSync(loader), 'expected built app/lib/app/load.js')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-loader-'))
  const entry = path.join(tmp, 'entry.js')

  fs.writeFileSync(path.join(tmp, 'local.js'), "exports.value = 'ok'\n")
  fs.writeFileSync(entry, [
    "const path = require('path')",
    "const local = require('./local')",
    "module.exports = { basename: path.basename(__filename), value: local.value }",
    ''
  ].join('\n'))

  const script = [
    `const load = require(${JSON.stringify(loader)}).default`,
    `const result = load(${JSON.stringify(entry)})`,
    "if (result.basename !== 'entry.js' || result.value !== 'ok') {",
    "  console.error(JSON.stringify(result))",
    '  process.exit(1)',
    '}'
  ].join('\n')

  childProcess.execFileSync('bun', ['-e', script], {
    cwd: root,
    stdio: 'pipe'
  })
}

function testMermaidStaticRuntime () {
  const mermaid = read('app', '_static', 'mermaid.min.js')
  assert.match(mermaid, /version:"11\.15\.0"/)
  assert.match(mermaid, /globalThis\["mermaid"\]/)

  const mermaidPlugin = read('app', 'pages', 'mermaid.js')
  assert.doesNotMatch(mermaidPlugin, /mermaid\.parse/)

  const page = read('app', 'pages', 'index.jsx')
  assert.match(page, /const mermaid = window\.mermaid/)
  assert.match(page, /typeof mermaid\.run === 'function'/)
  assert.match(page, /mermaid\.run\({ nodes: mermaidNodes }\)/)
  assert.match(page, /mermaid\.init\(undefined, mermaidNodes\)/)
}

function testBuildCacheHygiene () {
  const gitignore = read('.gitignore')
  assert.match(gitignore, /\*\.tsbuildinfo/)

  const tracked = childProcess.execFileSync('git', ['ls-files', 'app/tsconfig.tsbuildinfo'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  assert.strictEqual(tracked, '')

  childProcess.execFileSync('git', ['check-ignore', '-q', 'app/tsconfig.tsbuildinfo'], {
    cwd: root,
    stdio: 'ignore'
  })
}

function testStaticAssetCacheHeaders () {
  const routes = read('app', 'routes.js')

  assert.match(routes, /const CACHE_POLICIES = \{/)
  assert.match(routes, /immutable: 'public, max-age=31536000, immutable'/)
  assert.match(routes, /revalidate: 'public, max-age=0, must-revalidate'/)
  assert.match(routes, /noStore: 'no-store'/)
  assert.match(routes, /res\.setHeader\('Cache-Control', cacheControl\)/)
  assert.match(routes, /if \(cacheControl === CACHE_POLICIES\.noStore\) \{/)
  assert.match(routes, /res\.setHeader\('ETag', etag\)/)
  assert.match(routes, /res\.setHeader\('Last-Modified', stat\.mtime\.toUTCString\(\)\)/)
  assert.match(routes, /res\.statusCode = 304/)
  assert.match(routes, /return res\.end\(\)/)
  assert.match(routes, /ifNoneMatch === '\*'/)
  assert.match(routes, /mtimeSeconds\(stat\) <= modifiedSince/)
  assert.match(routes, /sendFile\(req, res, '\.\/out\/index\.html', CACHE_POLICIES\.noStore\)/)
  assert.match(routes, /sendFile\(req, res, fpath, CACHE_POLICIES\.immutable\)/)
  assert.match(routes, /sendFile\(req, res, fpath\)/)
}

function testStaticRoutesAvoidNvimVarLookups () {
  const server = read('app', 'server.js')
  assert.doesNotMatch(server, /req\.mkcss = await plugin\.nvim\.getVar/)
  assert.doesNotMatch(server, /req\.hicss = await plugin\.nvim\.getVar/)
  assert.doesNotMatch(server, /req\.custImgPath = await plugin\.nvim\.getVar/)

  const routes = read('app', 'routes.js')
  const markdownCssCheck = routes.indexOf("req.asPath === '/_static/markdown.css'")
  const markdownCssVar = routes.indexOf("getVar('mkdp_markdown_css')")
  const highlightCssCheck = routes.indexOf("req.asPath === '/_static/highlight.css'")
  const highlightCssVar = routes.indexOf("getVar('mkdp_highlight_css')")
  const imageRouteCheck = routes.indexOf("reg.test(req.asPath)")
  const imagePathVar = routes.indexOf("getVar('mkdp_images_path')")

  assert.ok(markdownCssCheck > -1, 'expected markdown CSS path gate')
  assert.ok(markdownCssVar > markdownCssCheck, 'expected markdown CSS var after path gate')
  assert.ok(highlightCssCheck > -1, 'expected highlight CSS path gate')
  assert.ok(highlightCssVar > highlightCssCheck, 'expected highlight CSS var after path gate')
  assert.ok(imageRouteCheck > -1, 'expected local image path gate')
  assert.ok(imagePathVar > imageRouteCheck, 'expected image path var inside image route')
  assert.doesNotMatch(routes, /logger\.error\('No such file:', req\.asPath, req\.mkcss, req\.hicss\)/)
}

function testStaticRouteRuntimeAvoidsNvimVarLookups () {
  const script = `
    const fs = require('fs')
    const http = require('http')
    const path = require('path')

    const root = ${JSON.stringify(root)}
    const appDir = path.join(root, 'app')
    const port = 31000 + (process.pid % 1000)
    const counts = {}
    let appApi = null

    const config = {
      mkdp_open_to_the_world: 0,
      mkdp_port: port,
      mkdp_port_range: 1,
      mkdp_markdown_css: '',
      mkdp_highlight_css: '',
      mkdp_images_path: '',
      mkdp_combine_preview: 0,
      mkdp_open_ip: '',
      mkdp_browserfunc: '',
      mkdp_browser: '',
      mkdp_echo_preview_url: 0
    }
    const fakePlugin = {
      nvim: {
        getVar: async (name) => {
          counts[name] = (counts[name] || 0) + 1
          return Object.prototype.hasOwnProperty.call(config, name) ? config[name] : ''
        },
        setVar: async () => {},
        call: async () => {},
        get buffers () {
          return Promise.resolve([])
        }
      },
      init: (api) => {
        appApi = api
      }
    }

    const nvimModule = path.join(appDir, 'nvim.js')
    require.cache[nvimModule] = {
      id: nvimModule,
      filename: nvimModule,
      loaded: true,
      exports: { plugin: fakePlugin }
    }

    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(file) : [file]
    })
    const pageBundle = walk(path.join(appDir, 'out', '_next', 'static'))
      .find((file) => file.endsWith(path.join('pages', 'index.js')))
    if (!pageBundle) {
      throw new Error('missing built page bundle')
    }
    const pageBundlePath = '/' + path.relative(path.join(appDir, 'out'), pageBundle).split(path.sep).join('/')

    const request = (pathname) => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.setTimeout(1000, () => {
        req.destroy(new Error('request timeout'))
      })
    })
    const waitForServer = async () => {
      for (let i = 0; i < 50; i += 1) {
        try {
          await request('/page/1')
          return
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      throw new Error('server did not start')
    }

    process.chdir(appDir)
    require(path.join(appDir, 'server.js')).run()

    ;(async () => {
      await waitForServer()
      await request(pageBundlePath)
      await request('/_static/page.css')
      if (counts.mkdp_markdown_css || counts.mkdp_highlight_css || counts.mkdp_images_path) {
        throw new Error('static requests read preview vars: ' + JSON.stringify(counts))
      }
      await request('/_static/markdown.css')
      if (counts.mkdp_markdown_css !== 1 || counts.mkdp_highlight_css || counts.mkdp_images_path) {
        throw new Error('unexpected custom CSS var reads: ' + JSON.stringify(counts))
      }
      process.exit(appApi ? 0 : 1)
    })().catch((error) => {
      console.error(error.stack || error.message)
      console.error(JSON.stringify(counts))
      process.exit(1)
    })
  `

  childProcess.execFileSync(process.execPath, ['-e', script], {
    cwd: root,
    stdio: 'pipe'
  })
}

async function main () {
  testAdmonitionRendering()
  testChartFenceRendering()
  testRenderErrorUsesTextContent()
  testKatexStaticRuntime()
  testPlantumlPlaceholderRendering()
  testPlantumlRendererRuntime()
  testNativePreviewSocketRuntime()
  testNativePreviewSocketIgnoresStaleEvents()
  testHighlightLanguageSubset()
  testHighlightRuntimeSubset()
  testScrollSource()
  testScrollRuntimeUsesDocumentOffset()
  testScrollRuntimeInterpolatesIndentedAdmonitionBody()
  testScrollRuntimeCachesSourceLineAnchors()
  testScrollRuntimeCoalescesAnimationFrame()
  await testAsyncMathRenderUsesLatestScrollPayload()
  await testPlainMarkdownSkipsMathAssets()
  testBuiltPreviewBundle()
  testRuntimeSelection()
  testMultiPortSupport()
  testNativePreviewTransport()
  testCursorSyncUsesLightweightEvent()
  testDebouncedContentRefresh()
  testHighFrequencyLogsAreDebugOnly()
  await testFollowupRenderWaitsForIdleAndCancelsStaleWork()
  testFreshRefreshSkipsFullContent()
  testSelectivePostRenderGates()
  testChartRendererIsLazyChunk()
  testPlantumlRendererIsLazyChunk()
  testBunCompatibleModuleLoader()
  testMermaidStaticRuntime()
  testBuildCacheHygiene()
  testStaticAssetCacheHeaders()
  testStaticRoutesAvoidNvimVarLookups()
  testStaticRouteRuntimeAvoidsNvimVarLookups()

  console.log('preview customization checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
