import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { firefox } from 'playwright-core'
import type { PreviewOptions, PreviewPayload } from '../app/src/types'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
assert.ok(fs.existsSync(path.join(root, 'app/out/index.html')), 'run bun run build-local first')
const route = require(path.join(root, 'app/lib/routes.js')).default
const WebSocket = require('ws')
const requests: string[] = []
const plugin = { nvim: { getVar: async () => ({}) } }
let fixture: PreviewPayload = {
  name: 'highlighting.md',
  theme: 'light',
  options: { disable_sync_scroll: true },
  content: ['# Plain document', '', '```text', 'plain code', '```']
}

const server = http.createServer((request, response) => {
  const pathname = (request.url || '').replace(/[?#].*$/, '')
  requests.push(pathname)
  route(Object.assign(request, { asPath: pathname, bufnr: '1', plugin }), response)
})
const sockets = new WebSocket.Server({ server, path: '/ws' })
sockets.on('connection', (client: { send: (message: string) => void }) => {
  client.send(JSON.stringify({ event: 'refresh_content', data: fixture }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\`\n`
function notify(event: string, data: unknown) {
  for (const client of sockets.clients) {
    client.send(JSON.stringify({ event, data }))
  }
}
function publish(source: string, options: PreviewOptions = {}) {
  fixture = { ...fixture, options: { disable_sync_scroll: true, ...options }, content: source.split('\n') }
  notify('refresh_content', fixture)
}

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-preview-highlighting-'))
let browser: Awaited<ReturnType<typeof firefox.launch>> | undefined
try {
  browser = await firefox.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1080, height: 1000 }, colorScheme: 'light' })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.addInitScript(() => {
    const state = window as unknown as {
      highlightMessages: Array<{ id: number, language: string }>
      highlightResponses: number
      setPreviewHidden: (hidden: boolean) => void
      holdHighlightRequests: boolean
      releaseHighlightRequests: () => void
    }
    state.highlightMessages = []
    state.highlightResponses = 0
    state.holdHighlightRequests = false
    const heldRequests: Array<() => void> = []
    state.releaseHighlightRequests = () => {
      state.holdHighlightRequests = false
      for (const send of heldRequests.splice(0)) send()
    }
    const observedWorkers = new WeakSet<Worker>()
    const postMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function(message, ...args) {
      if (message && typeof message.id === 'number' && typeof message.language === 'string') {
        if (!observedWorkers.has(this)) {
          observedWorkers.add(this)
          this.addEventListener('message', () => { state.highlightResponses += 1 })
        }
        state.highlightMessages.push({ id: message.id, language: message.language })
        if (state.holdHighlightRequests) {
          heldRequests.push(() => { Reflect.apply(postMessage, this, [message, ...args]) })
          return
        }
      }
      return Reflect.apply(postMessage, this, [message, ...args])
    }

    // Headless tab activation differs by browser; model visibility and its
    // suspended animation frames together, while keeping the real worker.
    let hidden = false
    const heldFrames = new Map<number, FrameRequestCallback>()
    const requestFrame = window.requestAnimationFrame.bind(window)
    const cancelFrame = window.cancelAnimationFrame.bind(window)
    Object.defineProperty(document, 'hidden', { get: () => hidden })
    window.requestAnimationFrame = (callback) => {
      const id = requestFrame(time => {
        if (hidden) heldFrames.set(id, callback)
        else callback(time)
      })
      return id
    }
    window.cancelAnimationFrame = (id) => { heldFrames.delete(id); cancelFrame(id) }
    state.setPreviewHidden = (value) => {
      hidden = value
      document.dispatchEvent(new Event('visibilitychange'))
      if (!hidden) {
        for (const callback of heldFrames.values()) requestFrame(callback)
        heldFrames.clear()
      }
    }
  })
  const messageCount = () => page.evaluate(() =>
    (window as unknown as { highlightMessages: unknown[] }).highlightMessages.length)
  const waitForHighlighting = () => page.waitForFunction(() =>
    document.querySelector('#markdown-body pre.shiki') && !document.querySelector('pre[data-highlight-id]'))

  const socketConnected = page.waitForEvent('websocket')
  await page.goto(`${base}/page/1`)
  const pageSocket = await socketConnected
  await page.waitForSelector('code.language-text')
  assert.equal(page.workers().length, 0, 'plain documents should not load a highlighting worker')
  const beforeLua = requests.length
  publish('# Lua\n\n' + fence('lua', 'local answer = 42\nprint(answer)'))
  await waitForHighlighting()
  assert.equal(page.workers().length, 1)
  const luaRequests = requests.slice(beforeLua)
  assert.ok(luaRequests.some(url => /\/lua-[\w-]+\.js$/.test(url)), 'Lua grammar must be fetched on demand')
  assert.ok(!luaRequests.some(url => /\/(rust|javascript|typescript|go)-[\w-]+\.js$/.test(url)),
    'a Lua document must not load unrelated grammars')
  console.log('ok - plain documents stay light; Lua fetches only its grammar')

  const richSource = [
    '# Code and terminal output',
    '',
    '$x^2 + y^2$',
    '',
    '## Lua',
    fence('LUA', 'local answer = 42\nprint("hello", answer)'),
    '## Rust in a quote',
    fence('rust', 'fn main() { println!("hello"); }').trimEnd().split('\n').map(line => `> ${line}`).join('\n'),
    '',
    '- JavaScript in a list',
    '',
    fence('js', 'const answer = 42;').trimEnd().split('\n').map(line => `  ${line}`).join('\n'),
    '',
    '## ANSI',
    fence('ansi', '\u001b[1;32mPASS\u001b[0m normal\n\u001b[38;5;196mred256\u001b[0m \u001b[38;2;1;2;3mrgb\u001b[0m\n\u001b[3;4mitalic underline\u001b[0m\n\u001b[31m<img src=x onerror=alert(1)>\u001b[0m'),
    fence('unknown-language', '<script>alert("not executable")</script>')
  ].join('\n')
  publish(richSource)
  await page.waitForSelector('.katex')
  await page.waitForFunction(() => document.querySelectorAll('#markdown-body pre.shiki').length === 4 &&
    !document.querySelector('pre[data-highlight-id]'))
  assert.equal(await page.locator('#markdown-body img, #markdown-body script').count(), 0)
  assert.equal(await page.locator('blockquote pre.shiki').count(), 1)
  assert.equal(await page.locator('li pre.shiki').count(), 1)
  assert.equal(await page.locator('code.language-ansi').textContent(),
    'PASS normal\nred256 rgb\nitalic underline\n<img src=x onerror=alert(1)>\n')
  const light = await page.locator('code.language-lua span[style]').first().evaluate(node => getComputedStyle(node).color)
  const lightBackground = await page.locator('pre.shiki').first().evaluate(node => getComputedStyle(node).backgroundColor)
  assert.equal(lightBackground, await page.locator('pre:not(.shiki)').evaluate(node => getComputedStyle(node).backgroundColor),
    'highlighted code should keep the preview code-block background')
  await page.screenshot({ path: path.join(artifacts, 'light.png'), fullPage: true })
  const beforeTheme = await messageCount()
  await page.locator('#page-header').hover()
  await page.locator('#theme').check()
  const dark = await page.locator('code.language-lua span[style]').first().evaluate(node => getComputedStyle(node).color)
  const darkBackground = await page.locator('pre.shiki').first().evaluate(node => getComputedStyle(node).backgroundColor)
  assert.equal(darkBackground, await page.locator('pre:not(.shiki)').evaluate(node => getComputedStyle(node).backgroundColor))
  assert.notEqual(light, dark)
  assert.notEqual(lightBackground, darkBackground)
  assert.equal(await messageCount(), beforeTheme, 'theme changes must not tokenize again')
  await page.screenshot({ path: path.join(artifacts, 'dark.png'), fullPage: true })
  publish('# Edited paragraph\n\n' + richSource)
  await page.waitForFunction(() => document.querySelector('#markdown-body h1')?.textContent?.includes('Edited paragraph'))
  assert.equal(await messageCount(), beforeTheme, 'prose edits must reuse completed code results')
  console.log('ok - nested fences, ANSI, math upgrades, theme switching and cached prose edits')

  const beforeStale = await messageCount()
  const stale = Array.from({ length: 120 }, (_, i) =>
    fence('js', (`const stale${i} = (n) => Math.max(n, 42);\n`).repeat(12))).join('\n')
  publish('# Stale document\n\n' + stale)
  await page.waitForFunction(() => document.querySelector('#markdown-body h1')?.textContent?.includes('Stale document') &&
    document.querySelector('pre[data-highlight-id]'))
  publish('# Newest document\n\n' + fence('lua', 'local newest = true'))
  await page.waitForFunction(() => document.querySelector('code.language-lua')?.textContent === 'local newest = true\n' &&
    !document.querySelector('pre[data-highlight-id]'))
  assert.ok(await messageCount() - beforeStale < 120, 'obsolete queued fences should be dropped')
  assert.doesNotMatch(await page.locator('#markdown-body').textContent() || '', /stale\d/)
  console.log('ok - late worker results never replace newer Markdown')

  const hiddenSource = Array.from({ length: 120 }, (_, i) =>
    fence('js', (`const hidden${i} = (n) => Math.max(n, 42);\n`).repeat(12))).join('\n')
  publish('# Hidden document\n\n' + hiddenSource)
  await page.waitForFunction(() => document.querySelector('#markdown-body h1')?.textContent?.includes('Hidden document') &&
    document.querySelector('pre[data-highlight-id]'))
  const hiddenState = await page.evaluate(() => {
    const state = window as unknown as {
      setPreviewHidden: (hidden: boolean) => void
      highlightMessages: Array<{ id: number }>
    }
    state.setPreviewHidden(true)
    return { sent: state.highlightMessages.length, activeId: state.highlightMessages.at(-1)!.id }
  })
  await page.waitForFunction(sent =>
    (window as unknown as { highlightResponses: number }).highlightResponses >= sent, hiddenState.sent, { polling: 20 })
  assert.equal(await messageCount(), hiddenState.sent, 'hidden previews must stop after the active request')
  assert.equal(await page.locator(`pre[data-highlight-id="${hiddenState.activeId}"]`).count(), 0,
    'completed HTML should not need a visible animation frame')
  const hiddenRefresh = pageSocket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('Hidden replacement')
  })
  publish('# Hidden replacement\n\n' + fence('lua', 'local after_hidden = true'))
  await hiddenRefresh
  const beforeRestore = await messageCount()
  await page.evaluate(() => (window as unknown as { setPreviewHidden: (hidden: boolean) => void }).setPreviewHidden(false))
  await page.waitForFunction(() => document.querySelector('code.language-lua')?.textContent === 'local after_hidden = true\n' &&
    !document.querySelector('pre[data-highlight-id]'))
  assert.equal(await messageCount(), beforeRestore + 1, 'restoring visibility must only dispatch the new document')
  console.log('ok - hidden previews stop dispatch and discard the replaced document queue')

  await page.evaluate(() => { (window as unknown as { holdHighlightRequests: boolean }).holdHighlightRequests = true })
  const sameContent = '# Same content\n\n' + [0, 1, 2].map(i => fence('lua', `local same${i} = true`)).join('\n')
  publish(sameContent)
  await page.waitForFunction(() => document.querySelectorAll('pre[data-highlight-id]').length === 3)
  fixture = { ...fixture, name: 'same-content.md' }
  notify('change_bufnr', 2)
  await page.waitForFunction(() => document.querySelector('#page-title-name')?.textContent === 'same-content')
  await page.evaluate(() => (window as unknown as { releaseHighlightRequests: () => void }).releaseHighlightRequests())
  await page.waitForFunction(() => document.querySelectorAll('pre.shiki').length === 3 &&
    !document.querySelector('pre[data-highlight-id]'))
  fixture = { ...fixture, name: 'empty.md', content: [] }
  notify('change_bufnr', 3)
  await page.waitForFunction(() => document.querySelector('#page-title-name')?.textContent === 'empty' &&
    document.querySelector('#markdown-body')?.textContent === '')
  console.log('ok - switching buffers rebuilds pending work for identical content and clears empty documents')

  const customOptions: PreviewOptions = { highlight: {
    languages: [
      { name: 'example', scopeName: 'source.example', aliases: ['example-alias'], repository: {},
        embeddedLanguages: ['js'],
        patterns: [{ begin: '<js>', end: '</js>', patterns: [{ include: 'source.js' }] },
          { match: '\\bHELLO\\b', name: 'keyword.control.example' }] },
      { name: 'invalid-example', scopeName: 'source.invalid-example', repository: {}, patterns: [],
        embeddedLanguages: ['not-an-installed-language'] }
    ],
    aliases: { custom: 'example-alias' }
  } }
  publish('# Custom grammar\n\n' + fence('custom', 'HELLO world\n<js>\nconst embedded = 42;\n</js>'), customOptions)
  await page.waitForSelector('pre.shiki code.language-custom span[style]')
  assert.match(await page.locator('code.language-custom').innerHTML(), />HELLO</)
  assert.match(await page.locator('code.language-custom').innerHTML(), />const</)
  const errorsBeforeInvalid = errors.length
  publish('# Invalid custom dependency\n\n' + fence('invalid-example', 'example') +
    fence('python', 'print("still works")'), customOptions)
  await page.waitForFunction(() => document.querySelector('pre.shiki code.language-python') &&
    !document.querySelector('pre[data-highlight-id]'))
  assert.ok(errors.length > errorsBeforeInvalid)
  assert.ok(errors.slice(errorsBeforeInvalid).every(message => message.includes('Unknown embedded language')))
  errors.splice(errorsBeforeInvalid)
  console.log('ok - custom dependency aliases work and invalid dependencies leave other languages functional')

  const benchmark = Array.from({ length: 200 }, (_, i) =>
    fence('javascript', (`const value${i} = (n) => Math.max(n, 42); // item ${i}\n`).repeat(12).trimEnd())).join('\n')
  await page.evaluate(() => {
    const state = window as unknown as { highlightBenchmark: Record<string, unknown> }
    const start = performance.now()
    const gaps: number[] = []
    let last = start
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now }, 16)
    let firstPaint = 0
    const observer = new MutationObserver(() => {
      if (!firstPaint && document.querySelector('#markdown-body h1')?.textContent?.includes('Benchmark')) {
        firstPaint = performance.now() - start
      }
    })
    observer.observe(document.querySelector('#markdown-body')!, { childList: true, subtree: true })
    state.highlightBenchmark = { start, gaps, timer, observer, firstPaint: () => firstPaint }
  })
  publish('# Benchmark\n\n' + benchmark)
  await page.waitForFunction(() => document.querySelectorAll('#markdown-body pre.shiki').length === 200 &&
    !document.querySelector('pre[data-highlight-id]'), undefined, { timeout: 30000 })
  const performanceResult = await page.evaluate(() => {
    const state = (window as unknown as { highlightBenchmark: {
      start: number, gaps: number[], timer: number, observer: MutationObserver, firstPaint: () => number
    } }).highlightBenchmark
    clearInterval(state.timer)
    state.observer.disconnect()
    const gaps = state.gaps.sort((a, b) => a - b)
    return { initialTextMs: state.firstPaint(), allHighlightedMs: performance.now() - state.start,
      heartbeatCount: gaps.length, p95HeartbeatMs: gaps[Math.floor(gaps.length * 0.95)], maxHeartbeatMs: gaps.at(-1) }
  })
  assert.ok(performanceResult.heartbeatCount > 5, 'the page event loop must run while the worker highlights')
  const afterBenchmark = await messageCount()
  publish('# Benchmark edited\n\n' + benchmark)
  await page.waitForFunction(() => document.querySelector('#markdown-body h1')?.textContent?.includes('Benchmark edited'))
  assert.equal(await messageCount(), afterBenchmark, 'all 200 unchanged blocks should stay cached')
  assert.deepEqual(errors, [], 'preview and worker should not emit browser errors')
  fs.writeFileSync(path.join(artifacts, 'performance.json'), JSON.stringify(performanceResult, null, 2))
  console.log('ok - 200-block document remains interactive and reuses cached highlighting')
  console.log(JSON.stringify({ performance: performanceResult, artifacts }, null, 2))
} finally {
  await browser?.close()
  for (const client of sockets.clients) client.terminate()
  sockets.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
