import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import katexModule from 'katex'

import { createMarkdownRenderer } from '../app/src/markdown-renderer'
import scrollToLine from '../app/src/scroll'
import type { KatexRenderer, ScrollPayload } from '../app/src/types'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function read(...parts: string[]) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

function exists(...parts: string[]) {
  return fs.existsSync(path.join(root, ...parts))
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return []
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

interface RouteResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
}

type PreviewRequest = http.IncomingMessage & {
  plugin: unknown
  bufnr: string
  asPath: string
}

type Route = (req: PreviewRequest, res: http.ServerResponse) => unknown

// Every getVar is an RPC round-trip to a possibly busy editor, so the routes
// are expected to ask only when a request could actually be configured.
let editorLookups = 0

const routePlugin = {
  init: () => {},
  nvim: {
    buffers: [],
    call: async () => '',
    getVar: async () => {
      editorLookups += 1
      return ''
    }
  }
}

function loadBuiltRoute(): Route {
  const mod = require(path.join(root, 'app', 'lib', 'routes.js')) as { default: Route }
  return mod.default
}

const header = (value: string | string[] | undefined) => Array.isArray(value) ? value.join(', ') : value || ''

function listen(server: http.Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address() as AddressInfo
      resolve(address.port)
    })
  })
}

function close(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function withRouteServer<T>(callback: (port: number) => Promise<T>) {
  // The routes resolve their own paths, so no cwd juggling is needed.
  const handleRoute = loadBuiltRoute()
  const server = http.createServer((req, res) => {
    const previewReq = req as PreviewRequest
    previewReq.plugin = routePlugin
    previewReq.bufnr = '1'
    previewReq.asPath = (req.url || '').replace(/[?#].*$/, '')
    handleRoute(previewReq, res)
  })

  try {
    const port = await listen(server)
    return await callback(port)
  } finally {
    await close(server).catch(() => {})
  }
}

function requestRoute(port: number, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<RouteResponse>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      headers
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function assertContentType(response: RouteResponse, prefix: string) {
  const value = header(response.headers['content-type'])
  assert.ok(value.startsWith(prefix), `expected ${prefix} content type, got ${value || '<missing>'}`)
}

function assertMarkdownRendering() {
  const katexRenderer = (katexModule as unknown as { default?: KatexRenderer }).default ||
    (katexModule as unknown as KatexRenderer)
  const md = createMarkdownRenderer({}, null, katexRenderer)
  const html = md.render([
    '!!! info Fingerprinting',
    '    A fingerprinting scheme.',
    '    - No false negatives',
    '',
    '$x^2$',
    '',
    '```chart',
    '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}',
    '```',
    '',
    '```mermaid',
    'graph LR',
    'A-->B',
    '```',
    '',
    '@startuml',
    'Alice -> Bob',
    '@enduml',
    '',
    '```dot',
    'digraph { a -> b; x [label=<<b>bold</b>>] }',
    '```',
    ''
  ].join('\n'))

  assert.match(html, /<div class="admonition info">/)
  assert.match(html, /<p class="admonition-title">Fingerprinting<\/p>/)
  assert.match(html, /A fingerprinting scheme\./)
  assert.match(html, /<li class="[^"]*source-line[^"]*" data-source-line="2">No false negatives<\/li>/)
  assert.match(html, /class="[^"]*source-line/)
  assert.match(html, /class="katex"/)
  assert.match(html, /<canvas class="chartjs">/)
  assert.match(html, /<div class="mermaid">graph LR/)
  assert.match(html, /class="plantuml-diagram"/)
  assert.match(html, /Alice -&gt; Bob/)
  // Graphviz HTML-like labels contain angle brackets, so the block must be
  // escaped or it tears a hole in the page instead of reaching renderDot.
  assert.match(html, /<div class="dot">digraph \{ a -&gt; b; x \[label=&lt;&lt;b&gt;bold&lt;\/b&gt;&gt;\]/)
  assert.doesNotMatch(html, /<div class="dot">[^<]*<b>/)

  const emptyTitle = md.render([
    '!!! warning ""',
    '    Hidden title.',
    ''
  ].join('\n'))
  assert.match(emptyTitle, /<div class="admonition warning">/)
  assert.doesNotMatch(emptyTitle, /admonition-title|&quot;&quot;|""/)
}

function makeAnchor(line: number, top: number): Element {
  return {
    getAttribute: (name: string) => name === 'data-source-line' ? String(line) : null,
    getBoundingClientRect: () => ({ top })
  } as unknown as Element
}

function installScrollDom(anchors: Element[], scrollCalls: Array<{ top: number, behavior: string }>) {
  const documentElement = {
    clientHeight: 200,
    scrollHeight: 2000,
    scrollTop: 0
  }

  Object.assign(globalThis, {
    window: {
      pageYOffset: 0,
      scrollTo: (options: { top: number, behavior: string }) => {
        scrollCalls.push(options)
      },
      requestAnimationFrame: (callback: () => void) => {
        callback()
        return 1
      }
    },
    document: {
      body: { scrollTop: 0 },
      documentElement,
      scrollingElement: documentElement,
      querySelectorAll: (selector: string) => {
        assert.equal(selector, '[data-source-line]')
        return anchors
      }
    }
  })
}

function assertScrollInterpolation() {
  const scrollCalls: Array<{ top: number, behavior: string }> = []
  installScrollDom([
    makeAnchor(0, 0),
    makeAnchor(10, 1000)
  ], scrollCalls)

  scrollToLine.invalidate()
  scrollToLine.middle({ cursor: 6, len: 12 })

  assert.deepEqual(scrollCalls, [{ top: 400, behavior: 'smooth' }])
}

function installPreviewDom() {
  const scrollCalls: Array<{ top: number, behavior: string }> = []
  const listeners = new Map<string, Array<() => void>>()
  let hidden = false

  const makeElement = () => ({
    addEventListener: () => {},
    checked: false,
    contentEditable: 'false',
    dataset: {},
    hidden: false,
    innerHTML: '',
    textContent: ''
  })

  const elements = new Map<string, unknown>([
    ['main', makeElement()],
    ['#page-ctn', makeElement()],
    ['#page-header', makeElement()],
    ['#page-title-name', makeElement()],
    ['#toggle-theme', makeElement()],
    ['#theme', makeElement()],
    ['#markdown-body', makeElement()]
  ])

  const documentElement = {
    clientHeight: 200,
    scrollHeight: 2000,
    scrollTop: 0
  }

  const document = {
    body: { scrollTop: 0 },
    documentElement,
    scrollingElement: documentElement,
    get hidden() {
      return hidden
    },
    addEventListener: (event: string, callback: () => void) => {
      const callbacks = listeners.get(event) || []
      callbacks.push(callback)
      listeners.set(event, callbacks)
    },
    querySelector: (selector: string) => elements.get(selector) || null,
    querySelectorAll: (selector: string) => {
      assert.equal(selector, '[data-source-line]')
      return [
        makeAnchor(0, 0),
        makeAnchor(100, 1000)
      ]
    }
  }

  Object.assign(globalThis, {
    window: {
      matchMedia: () => ({ matches: false }),
      pageYOffset: 0,
      requestAnimationFrame: (callback: () => void) => Number(setTimeout(callback, 0)),
      scrollTo: (options: { top: number, behavior: string }) => {
        scrollCalls.push(options)
      }
    },
    document
  })

  return {
    scrollCalls,
    dispatchVisibility: () => {
      for (const callback of listeners.get('visibilitychange') || []) {
        callback()
      }
    },
    setHidden: (value: boolean) => {
      hidden = value
    }
  }
}

const nextTick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function assertVisibleRestoreDoesNotReplayStaleScroll() {
  const { scrollCalls, dispatchVisibility, setHidden } = installPreviewDom()
  const { PreviewApp } = await import('../app/src/preview-app')
  const app = new PreviewApp() as unknown as {
    onSyncScroll: (payload: ScrollPayload) => void
  }
  const payload: ScrollPayload = {
    cursor: [0, 1, 1, 0],
    isActive: true,
    len: 100,
    options: { sync_scroll_type: 'middle' },
    winheight: 10,
    winline: 1
  }

  scrollToLine.invalidate()
  app.onSyncScroll(payload)
  await nextTick()
  assert.equal(scrollCalls.length, 1)

  scrollCalls.length = 0
  dispatchVisibility()
  await nextTick()
  assert.deepEqual(scrollCalls, [], 'visible preview restore should not replay stale editor scroll')

  setHidden(true)
  app.onSyncScroll({
    ...payload,
    cursor: [0, 21, 1, 0]
  })
  assert.deepEqual(scrollCalls, [], 'hidden preview should queue editor scroll without applying it')

  setHidden(false)
  dispatchVisibility()
  await nextTick()
  assert.equal(scrollCalls.length, 1, 'visible preview restore should apply scroll received while hidden once')

  scrollCalls.length = 0
  dispatchVisibility()
  await nextTick()
  assert.deepEqual(scrollCalls, [], 'queued hidden scroll should be consumed after restore')
}

async function assertServerRoutes() {
  assert.ok(exists('app/out/index.html'), 'run `bun run build-local` before `bun run test`')
  const indexHtml = read('app', 'out', 'index.html')
  const jsAsset = indexHtml.match(/src="([^"]+\.js)"/)?.[1]
  const cssAsset = indexHtml.match(/href="([^"]+\.css)"/)?.[1]

  assert.ok(jsAsset, 'expected built JavaScript asset in index.html')
  assert.ok(cssAsset, 'expected built CSS asset in index.html')

  const jsBasename = path.basename(jsAsset)
  const chunkAsset = walk(path.join(root, 'app', 'out', 'assets'))
    .map(file => `/assets/${path.basename(file)}`)
    .find(file => file.endsWith('.js') && path.basename(file) !== jsBasename)
  assert.ok(chunkAsset, 'expected non-entry JavaScript chunk')

  await withRouteServer(async (port) => {
    const page = await requestRoute(port, '/page/1')
    assert.equal(page.statusCode, 200)
    assert.equal(header(page.headers['cache-control']), 'no-store')
    assertContentType(page, 'text/html')
    assert.match(page.body, /id="markdown-body"/)

    const js = await requestRoute(port, jsAsset)
    assert.equal(js.statusCode, 200)
    assert.equal(header(js.headers['cache-control']), 'public, max-age=0, must-revalidate')
    assertContentType(js, 'text/javascript')

    const jsEtag = header(js.headers.etag)
    assert.match(jsEtag, /^W\//)
    const cachedJs = await requestRoute(port, jsAsset, { 'If-None-Match': jsEtag })
    assert.equal(cachedJs.statusCode, 304)
    assert.equal(cachedJs.body, '')

    const css = await requestRoute(port, cssAsset)
    assert.equal(css.statusCode, 200)
    assert.equal(header(css.headers['cache-control']), 'public, max-age=0, must-revalidate')
    assertContentType(css, 'text/css')

    const chunk = await requestRoute(port, chunkAsset)
    assert.equal(chunk.statusCode, 200)
    assert.equal(header(chunk.headers['cache-control']), 'public, max-age=31536000, immutable')
    assertContentType(chunk, 'text/javascript')

    const staticCss = await requestRoute(port, '/_static/page.css')
    assert.equal(staticCss.statusCode, 200)
    assertContentType(staticCss, 'text/css')

    const missing = await requestRoute(port, '/missing')
    assert.equal(missing.statusCode, 404)
    assertContentType(missing, 'text/html')

    // Serving assets must not stall on an editor that is busy in a blocking call.
    editorLookups = 0
    await requestRoute(port, '/_static/page.css')
    await requestRoute(port, jsAsset)
    assert.equal(editorLookups, 0, 'plain assets should not query the editor')

    // The two overridable stylesheets are the exception.
    await requestRoute(port, '/_static/markdown.css')
    assert.ok(editorLookups > 0, 'markdown.css should consult the css override config')
  })
}

async function assertNotificationDispatch() {
  const { dispatch } = await import('../src/attach/dispatch')

  const calls: string[] = []
  const app = {
    refreshPage: () => calls.push('refresh'),
    closePage: () => calls.push('close'),
    closeAllPages: () => calls.push('closeAll'),
    syncScroll: () => calls.push('scroll'),
    openBrowser: () => calls.push('open'),
    hasClients: () => hasClients,
    isContentFresh: () => contentFresh
  }
  let hasClients = true
  let contentFresh = false
  const payload = { bufnr: 1, data: { changedtick: 7, content: ['x'] } }

  // Nothing may reach the app before the server has initialised it.
  assert.equal(dispatch(undefined, 'refresh_content', payload), 'dropped-before-init')
  assert.deepEqual(calls, [])

  assert.equal(dispatch(app, 'something_else', payload), 'ignored')
  assert.deepEqual(calls, [])

  // Payload-less refreshes are dropped rather than reconstructed.
  assert.equal(dispatch(app, 'refresh_content', { bufnr: 1 }), 'dropped-without-data')
  assert.deepEqual(calls, [])

  // No browser tab means no work at all.
  hasClients = false
  assert.equal(dispatch(app, 'refresh_content', payload), 'dropped-without-clients')
  assert.deepEqual(calls, [])
  hasClients = true

  // Content the page already has is a viewport move, not a re-render.
  contentFresh = true
  assert.equal(dispatch(app, 'refresh_content', payload), 'scrolled')
  assert.deepEqual(calls, ['scroll'])

  calls.length = 0
  contentFresh = false
  assert.equal(dispatch(app, 'refresh_content', payload), 'refreshed')
  assert.deepEqual(calls, ['refresh'])

  // sync_scroll never re-renders, even when the content is stale.
  calls.length = 0
  assert.equal(dispatch(app, 'sync_scroll', payload), 'scrolled')
  assert.deepEqual(calls, ['scroll'])

  calls.length = 0
  assert.equal(dispatch(app, 'close_page', payload), 'closed')
  assert.equal(dispatch(app, 'open_browser', payload), 'opened')
  assert.deepEqual(calls, ['close', 'open'])
}

const configScript = `
vim.opt.runtimepath:append(vim.env.MKDP_TEST_ROOT)
vim.cmd('runtime plugin/markdown-preview.lua')

local mkdp = require('markdown-preview')
local config = require('markdown-preview.config')

-- Defaults reach the preview server even when setup() is never called.
assert(vim.g.mkdp_config.server.port_range == 32, 'defaults should be published')
assert(vim.g.mkdp_config.render.sync_scroll_type == 'middle', 'render defaults should be published')

for _, name in ipairs({ 'MarkdownPreview', 'MarkdownPreviewStop', 'MarkdownPreviewToggle' }) do
  assert(vim.api.nvim_get_commands({})[name], name .. ' should be defined')
end

mkdp.setup({
  filetypes = { 'markdown', 'quarto' },
  refresh = { events = { 'BufWritePost' } },
  server = { port = 18282 },
  browser = function(url) return url end,
  render = { katex = { macros = { ['\\\\e'] = '\\\\mathrm{e}' } } },
})

local opts = config.get()
-- Lists replace wholesale, so a shorter override really is shorter.
assert(#opts.filetypes == 2, 'filetypes should be replaced')
assert(#opts.refresh.events == 1, 'refresh.events should be replaced, got ' .. vim.inspect(opts.refresh.events))
-- Siblings of an overridden key keep their defaults.
assert(opts.refresh.debounce == 160, 'refresh.debounce should keep its default')
assert(opts.server.port_range == 32, 'server.port_range should keep its default')
assert(opts.render.sync_scroll_type == 'middle', 'render defaults should survive a partial override')
assert(opts.render.katex.macros['\\\\e'] == '\\\\mathrm{e}', 'nested user tables should survive')

-- An empty list means "none", an empty map means "no overrides".
config.setup({ refresh = { events = {} }, server = {} })
assert(#config.get().refresh.events == 0, 'an empty list should clear the default')
assert(config.get().server.port_range == 32, 'an empty map should keep the defaults')
config.setup({
  filetypes = { 'markdown', 'quarto' },
  server = { port = 18282 },
  browser = function(url) return url end,
})
opts = config.get()

-- The browser handler stays in lua; the server never sees it.
assert(type(opts.browser) == 'function', 'browser should stay a lua value')
assert(vim.g.mkdp_config.browser == nil, 'browser must not be mirrored to the server')
assert(vim.g.mkdp_config.server.port == 18282, 'server options should be mirrored')

-- render is forwarded to the page untouched, so its keys are not policed.
mkdp.setup({ render = { sync_scroll_type = 'top', katex = { macros = {} } } })
assert(config.get().render.sync_scroll_type == 'top', 'valid config should apply')
`

const browserScript = `
vim.opt.runtimepath:append(vim.env.MKDP_TEST_ROOT)

local config = require('markdown-preview.config')
local browser = require('markdown-preview.browser')

local calls = {}
config.setup({ browser = function(url) calls[#calls + 1] = url end })
browser.open('http://function')
assert(#calls == 1 and calls[1] == 'http://function', 'a function browser should receive the url')

-- A command list is spawned with the url appended as the last argument.
local out = vim.env.MKDP_TEST_OUT
config.setup({ browser = { 'sh', '-c', 'printf %s "$0" > ' .. out } })
browser.open('http://list')
vim.wait(5000, function() return vim.fn.filereadable(out) == 1 end, 20)
assert(vim.fn.readfile(out)[1] == 'http://list', 'a command list should receive the url')
`

const serverScript = `
vim.opt.runtimepath:append(vim.env.MKDP_TEST_ROOT)
vim.cmd('runtime plugin/markdown-preview.lua')

local received = nil
require('markdown-preview').setup({ browser = function(url) received = url end })

vim.cmd('edit ' .. vim.env.MKDP_TEST_ROOT .. '/test/test.md')
vim.cmd('MarkdownPreview')
vim.wait(30000, function() return received ~= nil end, 100)

assert(received and received:match('^http://localhost:%d+/page/%d+$'),
  'the preview server should hand the url back to lua, got ' .. tostring(received))
assert(require('markdown-preview').is_active(), 'the buffer should be marked active')

vim.cmd('MarkdownPreviewStop')
vim.wait(5000, function() return not require('markdown-preview').is_active() end, 50)
assert(not require('markdown-preview').is_active(), 'stopping should deactivate the buffer')
`

function hasExecutable(command: string) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function runNvimScript(name: string, script: string, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-test-'))
  const file = path.join(dir, name)

  try {
    fs.writeFileSync(file, script)
    execFileSync('nvim', ['--clean', '-l', file], {
      encoding: 'utf8',
      env: { ...process.env, MKDP_TEST_ROOT: root, ...env }
    })
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr || String(err)
    assert.fail(`${name} failed: ${detail.trim()}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function assertLuaConfig() {
  if (!hasExecutable('nvim')) {
    console.log('skip - lua config needs nvim')
    return
  }

  runNvimScript('config.lua', configScript)
}

function assertBrowserDispatch() {
  if (!hasExecutable('nvim')) {
    console.log('skip - browser dispatch needs nvim')
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-browser-'))
  try {
    runNvimScript('browser.lua', browserScript, { MKDP_TEST_OUT: path.join(dir, 'url') })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function assertServerOpensUrlWithHandler() {
  if (!hasExecutable('nvim')) {
    console.log('skip - preview server dispatch needs nvim')
    return
  }

  runNvimScript('server.lua', serverScript)
}


async function assertDotRendering() {
  const { instance } = await import('@viz-js/viz')
  const viz = await instance()

  const ok = viz.render('digraph { a -> b; b -> c }', { format: 'svg' })
  assert.equal(ok.status, 'success')
  assert.match(String(ok.output), /<svg\b/)
  assert.match(String(ok.output), /<title>a&#45;&gt;b<\/title>|a-&gt;b|a&#45;&gt;b/)

  // Invalid input must not throw; renderDot logs and moves on.
  assert.equal(viz.render('digraph { a -> ', { format: 'svg' }).status, 'failure')
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ['markdown rendering stays functional', assertMarkdownRendering],
  ['graphviz renders dot blocks', assertDotRendering],
  ['scroll interpolates between source anchors', assertScrollInterpolation],
  ['visible restore preserves preview scroll position', assertVisibleRestoreDoesNotReplayStaleScroll],
  ['server routes match Vite assets', assertServerRoutes],
  ['editor notifications are dispatched by policy', assertNotificationDispatch],
  ['lua config merges and mirrors to the server', assertLuaConfig],
  ['browser dispatch honours functions and commands', assertBrowserDispatch],
  ['preview server opens the url with the handler', assertServerOpensUrlWithHandler]
]

for (const [name, test] of tests) {
  await test()
  console.log(`ok - ${name}`)
}
