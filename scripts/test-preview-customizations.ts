import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import katexModule from 'katex'

import { createMarkdownRenderer } from '../app/src/markdown-renderer'
import scrollToLine from '../app/src/scroll'
import type { KatexRenderer } from '../app/src/types'

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

function runGit(args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8'
  }).trim()
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

const routePlugin = {
  init: () => {},
  nvim: {
    buffers: [],
    call: async () => '',
    getVar: async () => ''
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
  const cwd = process.cwd()
  process.chdir(path.join(root, 'app'))
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
    process.chdir(cwd)
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

function assertViteBuildOutput() {
  assert.equal(exists('app/out/index.html'), true, 'run bun run build-app before bun run test')
  assert.equal(exists('app/out/assets'), true, 'Vite assets directory is missing')

  const indexHtml = read('app', 'out', 'index.html')
  assert.match(indexHtml, /\/assets\/[^"]+\.js/)

  const assets = walk(path.join(root, 'app', 'out', 'assets'))
  assert.ok(assets.some((file) => file.endsWith('.js')), 'expected Vite JavaScript chunks')
  assert.ok(assets.some((file) => file.endsWith('.css')), 'expected Vite CSS chunks')
}

async function assertServerRoutes() {
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
  })
}

function assertNoClientGuard() {
  const attach = read('src', 'attach', 'index.ts')
  const initGuard = attach.indexOf('if (!currentApp)')
  const noClientGuard = attach.indexOf("method === 'refresh_content' || method === 'sync_scroll'")
  const bufferRead = attach.indexOf('const buffer = await findBuffer(bufnr)')

  assert.ok(initGuard >= 0, 'expected notifications before app init to be dropped')
  assert.ok(noClientGuard >= 0, 'expected refresh/sync no-client guard')
  assert.ok(bufferRead > noClientGuard, 'expected no-client guard before buffer content reads')
  assert.match(attach, /method === 'sync_scroll' && opts\.data/)
}

function assertBuildArtifactsIgnored() {
  const trackedGenerated = runGit([
    'ls-files',
    'app/out',
    'app/lib',
    'app/bin',
    'node_modules',
    'app/node_modules'
  ])
  assert.equal(trackedGenerated, '')

  const ignored = runGit([
    'check-ignore',
    'app/out/index.html',
    'app/out/assets/index.js',
    'app/lib/server.js',
    'app/node_modules/ws/package.json',
    'node_modules/vite/package.json'
  ]).split('\n').filter(Boolean)

  assert.deepEqual(ignored, [
    'app/out/index.html',
    'app/out/assets/index.js',
    'app/lib/server.js',
    'app/node_modules/ws/package.json',
    'node_modules/vite/package.json'
  ])
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ['markdown rendering stays functional', assertMarkdownRendering],
  ['scroll interpolates between source anchors', assertScrollInterpolation],
  ['vite build output is routed correctly', assertViteBuildOutput],
  ['server routes match Vite assets', assertServerRoutes],
  ['notifications are guarded before client work', assertNoClientGuard],
  ['generated build artifacts stay untracked', assertBuildArtifactsIgnored]
]

for (const [name, test] of tests) {
  await test()
  console.log(`ok - ${name}`)
}
