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

function testScrollSource () {
  const scrollSource = read('app', 'pages', 'scroll.js')

  assert.match(scrollSource, /function getDocumentOffsetTop/)
  assert.match(scrollSource, /getBoundingClientRect\(\)\.top \+ scrollTop/)
  assert.match(scrollSource, /distance > 0/)
  assert.doesNotMatch(scrollSource, /\.offsetTop\b/)
  assert.doesNotMatch(scrollSource, /TweenLite|Power2/)
}

function testScrollRuntimeUsesDocumentOffset () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  const scrollCalls = []
  const lineElement = {
    offsetTop: 0,
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
      querySelector: (selector) => (
        selector === '[data-source-line="12"]' ? lineElement : null
      )
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
  const anchors = {
    '[data-source-line="35"]': {
      offsetTop: 0,
      getBoundingClientRect: () => ({ top: 900 })
    },
    '[data-source-line="37"]': {
      offsetTop: 0,
      getBoundingClientRect: () => ({ top: 1100 })
    }
  }

  const context = {
    module: { exports: {} },
    window: { pageYOffset: 300 },
    document: {
      body: { scrollTop: 300 },
      documentElement: {
        scrollTop: 300,
        clientHeight: 600,
        scrollHeight: 2400
      },
      querySelector: (selector) => anchors[selector] || null
    },
    TweenLite: {
      to: (_element, _duration, options) => {
        scrollCalls.push(options.scrollTop)
      }
    },
    Power2: { easeOut: 'easeOut' }
  }

  vm.runInNewContext(source, context)
  context.module.exports.middle({
    cursor: 37,
    len: 1258
  })

  assert.deepStrictEqual(scrollCalls, [1000, 1000])
}

function testBuiltPreviewBundle () {
  const html = read('app', 'out', 'index.html')
  assert.match(html, /\/_static\/admonition\.css/)

  const staticRoot = path.join(root, 'app', 'out', '_next', 'static')
  const pageBundle = fs
    .readdirSync(staticRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(staticRoot, entry.name, 'pages', 'index.js'))
    .find((candidate) => fs.existsSync(candidate))

  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundle = fs.readFileSync(pageBundle, 'utf8')
  assert.match(bundle, /getBoundingClientRect\(\)\.top/)
  assert.match(bundle, /admonition\.css/)
  assert.doesNotMatch(bundle, /TweenLite\.to|Power2\.easeOut/)
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

  const autocmd = read('autoload', 'mkdp', 'autocmd.vim')
  assert.match(autocmd, /CursorMoved,CursorMovedI <buffer> call mkdp#rpc#preview_sync_scroll\(\)/)
  assert.doesNotMatch(autocmd, /CursorMoved[^\n]*preview_refresh/)

  const rpc = read('autoload', 'mkdp', 'rpc.vim')
  assert.match(rpc, /function! mkdp#rpc#preview_sync_scroll\(\)/)
  assert.match(rpc, /'sync_scroll'/)

  const attach = read('src', 'attach', 'index.ts')
  assert.match(attach, /const getScrollData = async/)
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
  assert.match(page, /if \(hasElement\('\.chartjs'\)\) \{\n\s+chart\.render\(\)/)
  assert.match(page, /renderWithLazyScripts\(MERMAID_SCRIPTS/)
  assert.match(page, /renderWithLazyScripts\(SEQUENCE_DIAGRAM_SCRIPTS, renderDiagram\)/)
  assert.match(page, /renderWithLazyScripts\(FLOWCHART_SCRIPTS, renderFlowchart\)/)
  assert.match(page, /renderWithLazyScripts\(DOT_SCRIPTS, renderDot\)/)

  const html = read('app', 'out', 'index.html')
  assert.doesNotMatch(html, /\/_static\/mermaid\.min\.js/)
  assert.doesNotMatch(html, /\/_static\/sequence-diagram-min\.js/)
  assert.doesNotMatch(html, /\/_static\/tweenlite\.min\.js/)
  assert.doesNotMatch(html, /\/_static\/flowchart@1\.13\.0\.min\.js/)
  assert.doesNotMatch(html, /\/_static\/full\.render\.js/)
  assert.match(html, /\/_static\/katex@0\.15\.3\.js/)
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
testScrollSource()
testScrollRuntimeUsesDocumentOffset()
testScrollRuntimeInterpolatesIndentedAdmonitionBody()
testBuiltPreviewBundle()
testRuntimeSelection()
testMultiPortSupport()
testCursorSyncUsesLightweightEvent()
testFreshRefreshSkipsFullContent()
testSelectivePostRenderGates()
testBunCompatibleModuleLoader()
testMermaidStaticRuntime()
testBuildCacheHygiene()

console.log('preview customization checks passed')
