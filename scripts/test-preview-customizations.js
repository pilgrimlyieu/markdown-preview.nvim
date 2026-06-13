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

function testHighlightLanguageSubset () {
  const page = read('app', 'pages', 'index.jsx')
  assert.match(page, /import hljs from '\.\/highlight'/)
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
function testBuiltPreviewBundle () {
  const html = read('app', 'out', 'index.html')
  assert.match(html, /\/_static\/admonition\.css/)

  const pageBundle = builtPageBundlePath()
  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundle = fs.readFileSync(pageBundle, 'utf8')
  const bundleSize = fs.statSync(pageBundle).size
  assert.match(bundle, /getBoundingClientRect\(\)\.top/)
  assert.match(bundle, /admonition\.css/)
  assert.doesNotMatch(bundle, /TweenLite\.to|Power2\.easeOut/)
  assert.doesNotMatch(bundle, /Chart\.js v2\./)
  assert.doesNotMatch(bundle, /pako|deflate/)
  assert.doesNotMatch(bundle, /accesslog/)
  assert.ok(
    bundleSize < 700000,
    `expected lean preview page bundle after optional dependency trimming, got ${bundleSize}`
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
  assert.match(page, /socket\.on\('sync_scroll', this\.onSyncScroll\.bind\(this\)\)/)
  assert.match(page, /onSyncScroll\(\{/)
  assert.match(page, /scrollToLine\[syncScrollType\] \|\| scrollToLine\.middle/)
  assert.match(page, /scrollToLine\.invalidate\(\)/)
  assert.match(page, /const refreshScroll = \(\) => this\.onSyncScroll/)
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
  assert.match(page, /const hasElement = \(selector\) => document\.querySelector\(selector\) !== null/)
  assert.match(page, /const mermaidNodes = document\.querySelectorAll\('\.mermaid'\)/)
  assert.match(page, /if \(!mermaidNodes\.length\) \{\n\s+return\n\s+\}/)
  assert.match(page, /if \(hasElement\('\.chartjs'\)\) \{\n\s+renderChart\(\)/)
  assert.match(page, /import\('\.\/chart-renderer'\)/)
  assert.match(page, /if \(hasElement\('\.plantuml-diagram'\)\) \{\n\s+renderPlantuml\(\)/)
  assert.match(page, /import\('\.\/plantuml-renderer'\)/)
  assert.match(page, /renderWithLazyScripts\(MERMAID_SCRIPTS/)
  assert.match(page, /renderWithLazyScripts\(SEQUENCE_DIAGRAM_SCRIPTS, renderDiagram\)/)
  assert.match(page, /renderWithLazyScripts\(FLOWCHART_SCRIPTS, renderFlowchart\)/)
  assert.match(page, /renderWithLazyScripts\(DOT_SCRIPTS, renderDot\)/)

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
  assert.match(html, /\/_static\/katex@0\.15\.3\.js/)
}

function testChartRendererIsLazyChunk () {
  const pageBundle = builtPageBundlePath()
  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundles = builtJsFiles().map((file) => ({
    file,
    source: fs.readFileSync(file, 'utf8')
  }))
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

  const bundles = builtJsFiles().map((file) => ({
    file,
    source: fs.readFileSync(file, 'utf8')
  }))
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

testAdmonitionRendering()
testChartFenceRendering()
testRenderErrorUsesTextContent()
testPlantumlPlaceholderRendering()
testPlantumlRendererRuntime()
testHighlightLanguageSubset()
testHighlightRuntimeSubset()
testScrollSource()
testScrollRuntimeUsesDocumentOffset()
testScrollRuntimeInterpolatesIndentedAdmonitionBody()
testScrollRuntimeCachesSourceLineAnchors()
testBuiltPreviewBundle()
testRuntimeSelection()
testMultiPortSupport()
testCursorSyncUsesLightweightEvent()
testFreshRefreshSkipsFullContent()
testSelectivePostRenderGates()
testChartRendererIsLazyChunk()
testPlantumlRendererIsLazyChunk()
testBunCompatibleModuleLoader()
testMermaidStaticRuntime()
testBuildCacheHygiene()

console.log('preview customization checks passed')
