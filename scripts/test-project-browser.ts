import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { firefox, type Browser, type Page } from 'playwright-core'
import { startPreview } from './preview-harness'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-project-browser-'))
const artifacts = process.env.MKDP_TEST_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-project-browser-artifacts-'))
fs.mkdirSync(artifacts, { recursive: true })
for (const dir of ['docs', 'src', 'many', 'second-project']) fs.mkdirSync(path.join(fixture, dir))
const filler = Array.from({ length: 70 }, (_, i) => `Paragraph ${i}. This project has several documents to read.\n`).join('\n')
const source = path.join(fixture, 'docs/editor.md')
const guide = path.join(fixture, 'docs/guide.md')
const code = '// Text files stay literal: <img src=x onerror="window.executed = true">\n' +
  Array.from({ length: 80 }, (_, i) => `const value${i}: number = ${i};`).join('\n')
const svg = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><rect width="${width}" height="${width}" fill="red"/></svg>`
fs.writeFileSync(source, '# Editor\n\n[Linked guide](guide.md)\n\n' + filler)
fs.writeFileSync(guide, '# Guide\n\n![Relative](picture.svg)\n\n[Source](editor.md)\n\n' + filler)
fs.writeFileSync(path.join(fixture, 'docs/picture.svg'), svg(24))
fs.writeFileSync(path.join(fixture, 'picture.svg'), svg(48))
fs.writeFileSync(path.join(fixture, 'src/demo.ts'), code)
fs.writeFileSync(path.join(fixture, 'src/second.ts'), 'const second: string = "a different highlight request";\n')
fs.writeFileSync(path.join(fixture, 'large.log'), 'log entry\n'.repeat(2000))
fs.writeFileSync(path.join(fixture, '.hidden.md'), '# Hidden\n')
fs.writeFileSync(path.join(fixture, 'docs/chart.md'), '# Chart\n\n```chart\n{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}\n```\n')
fs.writeFileSync(path.join(fixture, 'docs/math.md'), '# Math\n\n$\\frac{a}{b}$\n')
fs.writeFileSync(path.join(fixture, 'second-project/other.md'), '# Second project\n')
for (let i = 0; i < 431; i++) fs.writeFileSync(path.join(fixture, 'many', `${String(i).padStart(3, '0')}.md`), '# Entry\n')

async function heading(page: Page, title: string) {
  await page.waitForFunction(text => document.querySelector('#markdown-body h1')?.textContent?.trim() === text, title)
}
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function scroll(page: Page, top: number) {
  await page.evaluate(top => {
    document.querySelector('#markdown-body')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    window.scrollTo({ top, behavior: 'instant' })
  }, top)
  await frames(page)
}
const tree = (page: Page) => page.locator('#file-tree-entries')
const file = (page: Page, name: string) => tree(page).getByTitle(path.join(fixture, name), { exact: true })
async function folder(page: Page, name: string) {
  const button = tree(page).getByRole('button', { name, exact: true })
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
}

const releases: Array<() => void> = []
async function hold(page: Page, pattern: string, response = false) {
  let release!: () => void
  let captured!: () => void
  let url = ''
  const ready = new Promise<void>(resolve => { captured = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  await page.route(pattern, async route => {
    url = route.request().url()
    const fetched = response ? await route.fetch() : undefined
    captured()
    await gate
    try {
      if (fetched) await route.fulfill({ response: fetched })
      else await route.continue()
    } catch { /* The navigation may have cancelled this request. */ }
  }, { times: 1 })
  return { ready, release, url: () => url }
}

async function assertCombinedRoots(browser: Browser) {
  const preview = await startPreview(source, { server: { idle_timeout: 0 } }, fixture)
  const first = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pinned = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await first.bringToFront()
    await first.goto(preview.url)
    await heading(first, 'Editor')
    await first.getByRole('button', { name: 'Files', exact: true }).click()
    await tree(first).getByRole('button', { name: 'docs', exact: true }).waitFor()
    await pinned.bringToFront()
    const connected = pinned.waitForEvent('websocket')
    await pinned.goto(`${preview.url}?${new URLSearchParams({ path: guide, view: 'file' })}`)
    const pinnedSocket = await connected
    await heading(pinned, 'Guide')
    await pinned.getByRole('button', { name: 'Files', exact: true }).click()
    await tree(pinned).getByRole('button', { name: 'docs', exact: true }).waitFor()
    await preview.nvim.lua(`
      local root = ...
      local opts = require('markdown-preview.config').get()
      opts.combine.enabled = true
      require('markdown-preview').setup(opts)
      vim.cmd.lcd(root)
      vim.cmd.edit(root .. '/other.md')
    `, [path.join(fixture, 'second-project')])
    await first.bringToFront()
    await heading(first, 'Second project')
    await tree(first).getByRole('link', { name: 'other.md', exact: true }).waitFor()
    assert.equal(await first.locator('.file-tree-root').textContent(), path.join(fixture, 'second-project'))
    await pinned.bringToFront()
    await heading(pinned, 'Guide')
    assert.equal(await pinned.locator('.file-tree-root').textContent(), fixture)
    assert.equal(new URL(pinned.url()).pathname, `/page/${preview.bufnr}`)
    const closed = pinnedSocket.waitForEvent('framereceived', { predicate: message => String(message.payload).includes('close_page') })
    await preview.nvim.lua('vim.api.nvim_buf_delete(..., { force = true })', [preview.bufnr])
    await closed
    await first.bringToFront()
    await preview.nvim.lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, { '# Second project updated' }); vim.cmd('doautocmd BufWritePost')`)
    await heading(first, 'Second project updated')
    console.log('ok - combine changes only following roots; deleting a pinned owner preserves the other live preview')
  } finally {
    await first.close().catch(() => {})
    await pinned.close().catch(() => {})
    await preview.stop()
  }
}

async function assertBackgroundImage(browser: Browser, url: string) {
  const page = await browser.newPage()
  const resources: string[] = []
  page.on('request', request => { if (request.url().includes('/api/resource/')) resources.push(request.url()) })
  try {
    await page.addInitScript(() => Object.defineProperty(document, 'hidden', { value: true, configurable: true }))
    const connected = page.waitForEvent('websocket')
    await page.goto(`${url}?${new URLSearchParams({ path: path.join(fixture, 'picture.svg'), view: 'file' })}`)
    await connected
    await page.waitForLoadState('networkidle')
    assert.equal(resources.length, 0, 'a hidden image page connects to its owner without loading the image')
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img.file-image')?.naturalWidth === 64)
    assert.equal(resources.length, 1, 'the prepared image is moved into the page without a second request')
    console.log('ok - background image pages keep their owner connected and load once when visible')
  } finally {
    await page.close()
  }
}

let browser: Browser | undefined
let preview: Awaited<ReturnType<typeof startPreview>> | undefined
let page: Page | undefined
try {
  preview = await startPreview('docs/editor.md', {
    server: { idle_timeout: 0 }, refresh: { debounce: 120 }, scroll: { throttle: 0 },
    file_tree: { max_text_bytes: 8192 }
  }, fixture)
  browser = await firefox.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  page = await context.newPage()
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.addInitScript(() => {
    const state = window as unknown as { holdHighlights: boolean, heldHighlights: Array<() => void>, highlightResponses: number, previewSocket: WebSocket }
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        state.previewSocket = this
      }
    }
    state.holdHighlights = false
    state.heldHighlights = []
    state.highlightResponses = 0
    const observed = new WeakSet<Worker>()
    const postMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function(message, ...args) {
      if (message && typeof message.id === 'number' && typeof message.source === 'string') {
        if (!observed.has(this)) {
          observed.add(this)
          this.addEventListener('message', () => { state.highlightResponses++ })
        }
        if (state.holdHighlights) {
          state.heldHighlights.push(() => { Reflect.apply(postMessage, this, [message, ...args]) })
          return
        }
      }
      return Reflect.apply(postMessage, this, [message, ...args])
    }
  })
  const connected = page.waitForEvent('websocket')
  await page.goto(preview.url)
  let socket = await connected
  await heading(page, 'Editor')
  const originalBuffers = await preview.nvim.lua('return vim.api.nvim_list_bufs()')
  const originalCursor = await preview.nvim.lua('return vim.api.nvim_win_get_cursor(0)')
  assert.equal(requests.filter(url => url.includes('/api/files/')).length, 0)
  assert.equal(requests.filter(url => /\/assets\/file-tree-.*\.js/.test(url)).length, 0)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await tree(page).getByRole('button', { name: 'docs', exact: true }).waitFor()
  assert.equal(requests.filter(url => url.includes('/api/files/')).length, 1)
  assert.equal(await file(page, '.hidden.md').count(), 0)
  await page.getByLabel('Show hidden files').check()
  await file(page, '.hidden.md').waitFor()
  await page.getByLabel('Show hidden files').uncheck()
  await file(page, '.hidden.md').waitFor({ state: 'hidden' })
  await folder(page, 'docs')
  assert.equal(await file(page, 'docs/editor.md').getAttribute('aria-current'), 'page',
    'a source opened with a relative filename must still select its absolute tree entry')
  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide')
  assert.equal(new URL(page.url()).searchParams.get('view'), 'file')
  assert.equal(await file(page, 'docs/guide.md').getAttribute('aria-current'), 'page')
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('#markdown-body img')?.naturalWidth === 24)
  assert.deepEqual(await preview.nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers)
  assert.deepEqual(await preview.nvim.lua('return vim.api.nvim_win_get_cursor(0)'), originalCursor)
  const popupReady = context.waitForEvent('page')
  await file(page, 'docs/guide.md').click({ button: 'middle' })
  const popup = await popupReady
  await popup.bringToFront()
  await heading(popup, 'Guide')
  assert.equal(new URL(popup.url()).origin, new URL(preview.url).origin)
  await popup.close()
  await page.bringToFront()
  assert.deepEqual(await preview.nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers)
  console.log('ok - a lazy tree reads the captured cwd; same-page and middle-click reading preserve Neovim')

  await scroll(page, 420)
  const position = await page.evaluate(() => window.scrollY)
  const before = await page.evaluate(() => ({ length: history.length, entry: history.state.mkdpEntry }))
  fs.writeFileSync(guide, '# Guide updated\n\n![Relative](picture.svg)\n\n' + filler)
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await heading(page, 'Guide updated')
  assert.deepEqual(await page.evaluate(() => ({ length: history.length, entry: history.state.mkdpEntry })), before)
  assert.equal(await page.evaluate(() => window.scrollY), position)
  const visibleHeading = await page.evaluate(() => {
    const toolbar = document.querySelector('#preview-tools')!.getBoundingClientRect()
    return toolbar.bottom <= innerHeight && toolbar.top >= 0
  })
  assert.equal(visibleHeading, true, 'reading actions remain reachable without scrolling to the top')
  fs.unlinkSync(guide)
  const beforeMissing = page.url()
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await page.locator('#preview-message').waitFor({ state: 'visible' })
  await heading(page, 'Guide updated')
  assert.equal(page.url(), beforeMissing)
  assert.deepEqual(await page.evaluate(() => ({ length: history.length, entry: history.state.mkdpEntry })), before)
  fs.writeFileSync(guide, '# Guide updated\n\n![Relative](picture.svg)\n\n' + filler)
  console.log('ok - refresh re-reads content while preserving history entries, viewport and failed destinations')

  await folder(page, 'many')
  await file(page, 'many/000.md').waitFor()
  const directoryRequests = requests.filter(url => url.includes('/api/files/')).length
  await page.getByRole('searchbox', { name: 'Filter shown files' }).fill('guide')
  assert.equal(await file(page, 'many/000.md').count(), 0)
  await page.getByRole('searchbox', { name: 'Filter shown files' }).fill('')
  assert.equal(requests.filter(url => url.includes('/api/files/')).length, directoryRequests)
  await tree(page).getByRole('button', { name: 'Next page', exact: true }).click()
  await file(page, 'many/200.md').waitFor()
  assert.equal(await file(page, 'many/000.md').count(), 0)
  assert.ok(await tree(page).locator('.file-tree-entry').count() < 250)
  await page.keyboard.press('Enter')
  await file(page, 'many/400.md').waitFor()
  assert.equal(await tree(page).getByRole('button', { name: 'Previous page', exact: true })
    .evaluate(node => node === document.activeElement), true, 'the last page keeps focus on an available paging action')
  await page.keyboard.press('Enter')
  await file(page, 'many/200.md').waitFor()
  await scroll(page, 500)
  await tree(page).hover()
  await frames(page)
  await page.mouse.wheel(0, 1000)
  await frames(page)
  assert.equal(await page.evaluate(() => window.scrollY), 500)
  await tree(page).getByRole('button', { name: 'many', exact: true }).click()
  console.log('ok - directory pages replace rows, filtering does no I/O and tree scrolling stays independent')

  const directory = await hold(page, `**/api/files/${preview.bufnr}?*`, true)
  await tree(page).getByRole('button', { name: 'src', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await directory.ready
  await page.keyboard.press('ArrowLeft')
  directory.release()
  await frames(page)
  assert.equal(await file(page, 'src/demo.ts').count(), 0)
  assert.equal(await tree(page).getByRole('button', { name: 'src', exact: true }).getAttribute('aria-expanded'), 'false')
  await page.keyboard.press('ArrowRight')
  await file(page, 'src/demo.ts').waitFor()
  await page.keyboard.press('ArrowDown')
  assert.equal(await file(page, 'src/demo.ts').evaluate(node => node === document.activeElement), true)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await tree(page).getByRole('button', { name: 'src', exact: true }).evaluate(node => node === document.activeElement), true)
  console.log('ok - keyboard disclosure cancels a pending directory and can reopen it without stale rows')

  await file(page, 'src/demo.ts').click()
  await page.waitForSelector('[data-file-kind="text"] pre.shiki')
  assert.equal(await page.locator('#markdown-body code').textContent(), code)
  assert.equal(await page.locator('#markdown-body [onerror]').count(), 0)
  assert.equal(await page.evaluate(() => (window as unknown as { executed?: boolean }).executed), undefined)
  await file(page, 'picture.svg').click()
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img.file-image')?.naturalWidth === 48)
  const imageEntry = await page.evaluate(() => ({ length: history.length, entry: history.state.mkdpEntry }))
  fs.writeFileSync(path.join(fixture, 'picture.svg'), svg(64))
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img.file-image')?.naturalWidth === 64)
  const imageUrl = page.url()
  const oldImage = await page.locator('img.file-image').elementHandle()
  await page.route(`**/api/resource/${preview.bufnr}?*`, route => route.fulfill({ status: 403, body: 'File unavailable' }), { times: 1 })
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await page.locator('#preview-message').waitFor({ state: 'visible' })
  assert.equal(await oldImage!.evaluate(img => img === document.querySelector('img.file-image') && img.naturalWidth === 64), true)
  assert.equal(page.url(), imageUrl)
  assert.deepEqual(await page.evaluate(() => ({ length: history.length, entry: history.state.mkdpEntry })), imageEntry)
  const imageLoad = await hold(page, `**/api/resource/${preview.bufnr}?*`, true)
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await imageLoad.ready
  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide updated')
  imageLoad.release()
  await frames(page)
  assert.equal(await page.locator('img.file-image').count(), 0)
  console.log('ok - image refresh loads new bytes, retains the old image on failure and cancels on navigation')

  await file(page, 'large.log').click()
  await page.waitForSelector('[data-file-kind="attachment"]')
  const downloadReady = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file', exact: true }).click()
  const download = await downloadReady
  assert.equal(download.suggestedFilename(), 'large.log')
  assert.equal(await download.failure(), null)
  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide updated')
  console.log('ok - literal highlighted text, selected images and large-file downloads use working service URLs')

  const refresh = await hold(page, `**/api/preview/${preview.bufnr}?*`, true)
  await page.getByRole('button', { name: 'Refresh file', exact: true }).click()
  await refresh.ready
  await file(page, 'src/demo.ts').click()
  await page.waitForSelector('[data-file-kind="text"]')
  refresh.release()
  await frames(page)
  assert.equal(new URL(page.url()).searchParams.get('path'), path.join(fixture, 'src/demo.ts'))
  assert.equal(await page.locator('[data-file-kind="text"]').count(), 1)
  await page.goBack()
  await heading(page, 'Guide updated')
  await page.goForward()
  await page.waitForSelector('[data-file-kind="text"]')
  const reconnected = page.waitForEvent('websocket')
  await page.reload()
  socket = await reconnected
  await page.waitForSelector('[data-file-kind="text"]')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await folder(page, 'docs')
  await folder(page, 'src')
  console.log('ok - cancelled refreshes, browser history and reload preserve file-view identity')

  const chart = await hold(page, '**/assets/chart-renderer-*.js')
  await file(page, 'docs/chart.md').click()
  await chart.ready
  await file(page, 'picture.svg').click()
  await page.waitForSelector('img.file-image')
  chart.release()
  await page.evaluate(url => import(url), chart.url())
  await frames(page)
  assert.equal(await page.locator('canvas').count(), 0)
  assert.equal(await page.locator('img.file-image').count(), 1)
  const math = await hold(page, '**/assets/katex-*.js')
  await file(page, 'docs/math.md').click()
  await math.ready
  await file(page, 'src/demo.ts').click()
  await page.waitForSelector('[data-file-kind="text"]')
  math.release()
  await page.evaluate(url => import(url), math.url())
  await frames(page)
  assert.equal(await page.locator('[data-file-kind="text"]').count(), 1)
  assert.equal(await page.locator('#markdown-body .katex').count(), 0)
  await page.evaluate(() => { (window as unknown as { holdHighlights: boolean }).holdHighlights = true })
  await file(page, 'src/second.ts').click()
  await page.waitForFunction(() => (window as unknown as { heldHighlights: unknown[] }).heldHighlights.length > 0)
  await file(page, 'picture.svg').click()
  await page.waitForSelector('img.file-image')
  const responses = await page.evaluate(() => {
    const state = window as unknown as { holdHighlights: boolean, heldHighlights: Array<() => void>, highlightResponses: number }
    state.holdHighlights = false
    for (const send of state.heldHighlights.splice(0)) send()
    return state.highlightResponses
  })
  await page.waitForFunction(count => (window as unknown as { highlightResponses: number }).highlightResponses > count, responses)
  assert.equal(await page.locator('img.file-image').count(), 1)
  assert.equal(await page.locator('#markdown-body pre').count(), 0)
  console.log('ok - late chart, math and highlighting work cannot overwrite another file type')

  await page.getByRole('link', { name: 'Back to source', exact: true }).click()
  await heading(page, 'Editor')
  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide updated')
  await preview.nvim.lua(`
    vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# Edited before leaving' })
    vim.cmd('doautocmd TextChanged')
    vim.cmd.enew()
  `)
  await new Promise(resolve => setTimeout(resolve, 180))
  const currentBuffer = await preview.nvim.lua('return vim.api.nvim_get_current_buf()')
  await page.goBack()
  await heading(page, 'Edited before leaving')
  assert.equal(await preview.nvim.lua('return vim.api.nvim_get_current_buf()'), currentBuffer)
  assert.equal(new URL(page.url()).searchParams.get('path'), null)
  assert.equal(new URL(page.url()).searchParams.get('view'), null)
  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide updated')
  const snapshot = await hold(page, `**/api/source/${preview.bufnr}`, true)
  await page.getByRole('link', { name: 'Back to source', exact: true }).click()
  await snapshot.ready
  const newest = socket.waitForEvent('framereceived', { predicate: message => String(message.payload).includes('Newest source') })
  await preview.nvim.lua(`
    vim.api.nvim_set_current_buf(...)
    vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# Newest source' })
    vim.cmd('doautocmd BufWritePost')
  `, [preview.bufnr])
  await newest
  snapshot.release()
  await heading(page, 'Newest source')
  for (const name of ['', path.join(fixture, 'docs/renamed.md')]) {
    await file(page, 'docs/guide.md').click()
    await heading(page, 'Guide updated')
    await preview.nvim.lua('local bufnr, name = ...; vim.api.nvim_buf_set_name(bufnr, name)', [preview.bufnr, name])
    await page.getByRole('link', { name: 'Back to source', exact: true }).click()
    await heading(page, 'Newest source')
    assert.equal(await page.locator('#page-title-name').textContent(), name ? 'renamed' : '')
  }
  console.log('ok - browser Back and Back to source refresh missed edits, merge newer WS data and handle unnamed/renamed buffers')

  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide updated')
  const metadata = await hold(page, `**/api/source/${preview.bufnr}`, true)
  await page.getByRole('link', { name: 'Back to source', exact: true }).click()
  await metadata.ready
  await preview.nvim.lua('local bufnr, name = ...; vim.api.nvim_buf_set_name(bufnr, name)',
    [preview.bufnr, path.join(fixture, 'docs/reconnected.md')])
  const reconnect = page.waitForEvent('websocket')
  await page.evaluate(() => (window as unknown as { previewSocket: WebSocket }).previewSocket.close())
  socket = await reconnect
  await socket.waitForEvent('framereceived', { predicate: message => String(message.payload).includes('reconnected.md') })
  metadata.release()
  await heading(page, 'Newest source')
  assert.equal(await page.locator('#page-title-name').textContent(), 'reconnected')
  console.log('ok - a newer socket snapshot wins a same-changedtick HTTP response after a rename')

  await preview.nvim.lua(`
    local opts = require('markdown-preview.config').get()
    opts.render.mkit = { typographer = false }
    require('markdown-preview').setup(opts)
    vim.api.nvim_buf_set_lines(0, 4, 5, false, { '"Literal" ...' })
    vim.cmd('doautocmd BufWritePost')
  `)
  await page.waitForFunction(() => document.querySelector('[data-source-line="4"]')?.textContent === '"Literal" ...')
  const metadataTick = await preview.nvim.lua('return vim.api.nvim_buf_get_changedtick(0)')
  await preview.nvim.lua(`
    vim.api.nvim_buf_set_name(0, ...)
    local opts = require('markdown-preview.config').get()
    opts.page_title = 'Live $' .. '{name}'
    opts.render.disable_filename = true
    opts.render.content_editable = true
    require('markdown-preview').setup(opts)
    vim.cmd('doautocmd BufWritePost')
  `, [path.join(fixture, 'docs/live-renamed.md')])
  await page.waitForFunction(() => document.title === 'Live live-renamed')
  assert.equal(await page.title(), 'Live live-renamed')
  assert.equal(await page.locator('#page-header').isHidden(), true)
  assert.equal(await page.locator('#page-ctn').getAttribute('contenteditable'), 'true')
  await preview.nvim.lua(`
    local opts = require('markdown-preview.config').get()
    opts.render.mkit.typographer = true
    require('markdown-preview').setup(opts)
    vim.cmd('doautocmd BufWritePost')
  `)
  await page.waitForFunction(() => document.querySelector('[data-source-line="4"]')?.textContent === '“Literal” …')
  assert.equal(await preview.nvim.lua('return vim.api.nvim_buf_get_changedtick(0)'), metadataTick)
  const paragraph = await page.locator('[data-source-line="4"]').elementHandle()
  await preview.nvim.lua(`
    local opts = require('markdown-preview.config').get()
    opts.page_title = 'Reconnected $' .. '{name}'
    opts.render.disable_filename = false
    opts.render.content_editable = false
    require('markdown-preview').setup(opts)
  `)
  const metadataReconnect = page.waitForEvent('websocket')
  await page.evaluate(() => (window as unknown as { previewSocket: WebSocket }).previewSocket.close())
  socket = await metadataReconnect
  await page.waitForFunction(() => document.title === 'Reconnected live-renamed')
  assert.equal(await page.locator('#page-header').isVisible(), true)
  assert.equal(await page.locator('#page-ctn').getAttribute('contenteditable'), 'false')
  assert.equal(await paragraph!.evaluate(node => node === document.querySelector('[data-source-line="4"]')), true,
    'title and display options should not replace unchanged document content')
  console.log('ok - same-tick refresh and reconnect update names, options and titles while preserving unchanged DOM')

  await preview.nvim.lua(`
    local opts = require('markdown-preview.config').get()
    opts.render.sync_scroll_type = 'relative'
    require('markdown-preview').setup(opts)
    vim.wo.wrap = false
    vim.wo.scrolloff = 0
  `)
  for (const placement of ['zb', 'zt']) {
    const scrolled = socket.waitForEvent('framereceived', { predicate: message => String(message.payload).includes('sync_scroll') })
    const view = await preview.nvim.lua(`
      vim.cmd('normal! 81G' .. (...))
      vim.cmd('doautocmd CursorMoved')
      return { vim.fn.winline(), vim.api.nvim_win_get_height(0) }
    `, [placement]) as number[]
    await scrolled
    assert.equal(view[0], placement === 'zb' ? view[1] : 1)
    await page.waitForFunction(bottom => {
      const anchor = document.querySelector('[data-source-line="80"]')!.getBoundingClientRect()
      const toolbar = document.querySelector('#preview-tools')!.getBoundingClientRect()
      return anchor.top >= 0 && anchor.bottom <= toolbar.top + 1 &&
        (bottom ? anchor.top > toolbar.top - 60 : anchor.top < 100)
    }, placement === 'zb')
  }
  console.log('ok - relative scroll keeps the real editor top and bottom rows readable above the footer')

  await file(page, 'src/demo.ts').click()
  await page.waitForSelector('[data-file-kind="text"] pre.shiki')
  await scroll(page, 0)
  await page.screenshot({ path: path.join(artifacts, 'reader-light.png') })
  await page.locator('#page-header').hover()
  await page.locator('#theme').check()
  await page.screenshot({ path: path.join(artifacts, 'reader-dark.png') })
  await preview.nvim.lua(`
    local opts = require('markdown-preview.config').get()
    opts.render.disable_filename = true
    opts.render.content_editable = true
    require('markdown-preview').setup(opts)
  `)
  await file(page, 'docs/guide.md').click()
  await heading(page, 'Guide updated')
  assert.equal(await page.locator('#page-header').isHidden(), true)
  assert.equal(await page.locator('#page-ctn').getAttribute('contenteditable'), 'true')
  assert.equal(await page.locator('#preview-files').evaluate(node => node.isContentEditable), false)
  assert.equal(await page.locator('#preview-tools').evaluate(node => node.isContentEditable), false)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await scroll(page, 420)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.screenshot({ path: path.join(artifacts, 'reader-mobile.png') })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#preview-files').isHidden(), true)
  assert.equal(await page.locator('#toggle-files').evaluate(node => node === document.activeElement), true)
  assert.equal(await page.evaluate(() => window.scrollY), 420)
  assert.deepEqual(errors, [])
  console.log('ok - light/dark, narrow screens, keyboard dismissal and hidden/editable document options remain usable')

  await assertBackgroundImage(browser, preview.url)
  // The helper below uses the on-disk guide, independently of the current buffer.
  fs.writeFileSync(guide, '# Guide\n\n' + filler)
  await assertCombinedRoots(browser)
  console.log(JSON.stringify({ artifacts }, null, 2))
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally {
  for (const release of releases) release()
  await browser?.close()
  await preview?.stop()
  fs.rmSync(fixture, { recursive: true, force: true })
}
