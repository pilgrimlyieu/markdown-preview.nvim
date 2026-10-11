import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { firefox } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { createMarkdownRenderer } from '../app/src/markdown-renderer'
import { startPreview } from './preview-harness'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-preview-'))
fs.mkdirSync(path.join(fixture, 'docs'))
fs.mkdirSync(path.join(fixture, 'assets'))
const filler = Array.from({ length: 70 }, (_, i) => `Paragraph ${i}.\n`).join('\n')
const chart = '```chart\n{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}\n```'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'
fs.writeFileSync(path.join(fixture, 'assets/icon.svg'), svg)
fs.writeFileSync(path.join(fixture, 'docs/a&b.svg'), svg)
for (const name of ['percent%.svg', 'hash#name.svg', 'literal%20.svg']) {
  fs.writeFileSync(path.join(fixture, 'docs', name), svg)
}
fs.writeFileSync(path.join(fixture, 'docs/index.md'), [
  '# Preview', '[Read](#reading)', '[Other](other.md)',
  '![Root image](/assets/icon.svg)', '[Open image](/assets/icon.svg)',
  '![Quoted "alt"](a&b.svg =20x20)', '<img src="a&amp;b.svg" alt="HTML image">',
  '![Fragment](a&b.svg#icon)', '![Query](a&b.svg?cache=1)',
  '<img src="percent%.svg" alt="HTML percent">', '![Encoded percent](percent%25.svg)',
  '![Encoded hash](hash%23name.svg)', '![Literal escape](literal%2520.svg)',
  filler, '## Reading', filler
].join('\n\n'))
fs.writeFileSync(path.join(fixture, 'docs/other.md'), '# Other\n\n' + filler)
fs.writeFileSync(path.join(fixture, 'docs/chart-a.md'), '# Chart A\n\n[To B](chart-b.md)\n\n' + chart)
fs.writeFileSync(path.join(fixture, 'docs/chart-b.md'), '# Chart B\n\n$x^2$\n\n' + chart)
fs.writeFileSync(path.join(fixture, 'docs/bad-chart.md'), '# Invalid chart\n\n[Leave](chart-clean.md)\n\n' + chart.replace('"bar"', '"typo"'))
fs.writeFileSync(path.join(fixture, 'docs/chart-clean.md'), '# No chart\n\n[Return](bad-chart.md)')
fs.writeFileSync(path.join(fixture, 'docs/dot.md'), '# Dot\n\n[Invalid](bad-dot.md)\n\n> ```dot\n> digraph { a [URL="other.md"]; a -> b }\n> ```\n\n' + chart.replace(/^/gm, '> '))
fs.writeFileSync(path.join(fixture, 'docs/bad-dot.md'), '# Invalid dot\n\n[Recover](dot.md)\n\n```dot\ndigraph { a ->\n```')

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function heading(page: Page, title: string) {
  await page.waitForFunction(text => document.querySelector('#markdown-body h1')?.textContent?.trim() === text, title)
}

async function assertEscapedMarkdown(browser: Browser) {
  const page = await browser.newPage()
  await page.route('http://preview.test/**', route => route.fulfill({
    status: route.request().url().endsWith('/') ? 200 : 404,
    contentType: 'text/html', body: '<!doctype html><body><main></main></body>'
  }))
  await page.goto('http://preview.test/')
  const md = createMarkdownRenderer({ mkit: { html: false, typographer: false } })
  const injectedImage = '<img src=missing onerror=document.body.dataset.executed=1>'
  const sources = [
    ['image', '![x" onerror="document.body.dataset.executed=1](missing)'],
    ['sequence', '```sequence-diagrams\nAlice->Bob: ' + injectedImage + '\n```'],
    ['flowchart', '```flowchart\nst=>start: ' + injectedImage + '\n```'],
    ['chart', '```chart\n' + JSON.stringify({ type: 'bar', data: { labels: ['</canvas>' + injectedImage], datasets: [] } }) + '\n```'],
    ['invalid chart', '```chart\n' + injectedImage + '\n```']
  ]
  for (const [name, source] of sources) {
    await page.evaluate(html => {
      delete document.body.dataset.executed
      document.querySelector('main')!.innerHTML = html
    }, md.render(source))
    await frames(page)
    assert.equal(await page.locator('[onerror]').count(), 0, `${name} must not turn source text into event attributes`)
    assert.equal(await page.locator('img').count(), name === 'image' ? 1 : 0, `${name} must not inject images`)
    assert.equal(await page.evaluate(() => document.body.dataset.executed), undefined)
  }
  await page.close()
  console.log('ok - image attributes and custom fences preserve text without executing HTML')
}

async function assertChartNavigation(browser: Browser, url: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  let release!: () => void
  let markRequested!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { markRequested = resolve })
  await page.route('**/assets/chart-renderer-*.js', async route => {
    const response = await route.fetch()
    markRequested()
    await released
    await route.fulfill({ response })
  })
  try {
    await page.goto(`${url}?path=${encodeURIComponent(path.join(fixture, 'docs/chart-a.md'))}`)
    await heading(page, 'Chart A')
    await requested
    await page.getByRole('link', { name: 'To B' }).click()
    await heading(page, 'Chart B')
    await page.waitForSelector('.katex')
    // Both the navigation and math upgrade have replaced the DOM while the
    // same diagram module was loading. Let their queued idle work run first.
    await page.evaluate(() => new Promise<void>(resolve => requestIdleCallback(() => resolve(), { timeout: 1000 })))
    release()
    await page.waitForFunction(() => {
      if (document.querySelector('#markdown-body pre')?.textContent?.includes('complains')) return true
      const canvas = document.querySelector<HTMLCanvasElement>('#markdown-body canvas')
      return canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        .some((value, index) => index % 4 === 3 && value > 0)
    })
    assert.equal(await page.locator('#markdown-body canvas').count(), 1, 'late tasks must not destroy the current chart')
    assert.doesNotMatch(await page.locator('#markdown-body').textContent() || '', /complains|Canvas is already in use/)
  } finally {
    release()
    await context.close()
  }
  console.log('ok - late chart tasks respect navigation and same-version math DOM replacements')
}

async function assertDotRecovery(browser: Browser, preview: Awaited<ReturnType<typeof startPreview>>) {
  const { nvim, bufnr, url } = preview
  const page = await browser.newPage()
  const navigations: string[] = []
  page.on('request', request => { if (request.isNavigationRequest()) navigations.push(request.url()) })
  const originalBuffers = await nvim.lua('return vim.api.nvim_list_bufs()')
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const chartRequested = page.waitForRequest('**/assets/chart-renderer-*.js')
  await page.route('**/assets/chart-renderer-*.js', async route => {
    await released
    await route.continue()
  })
  try {
    await page.goto(`${url}?path=${encodeURIComponent(path.join(fixture, 'docs/dot.md'))}`)
    await chartRequested
    await page.waitForSelector('.dot svg')
    assert.match(await page.locator('.dot svg').textContent() || '', /a->b/)
    navigations.length = 0
    // The SVG is usable before its unrelated sibling chart has loaded.
    await page.locator('.dot svg a').click()
    await heading(page, 'Other')
    assert.equal(new URL(page.url()).searchParams.get('path'), path.join(fixture, 'docs/other.md'))
    assert.deepEqual(navigations, [], 'diagram links must use in-page navigation')
    assert.equal(await nvim.lua('return vim.api.nvim_get_current_buf()'), bufnr)
    assert.deepEqual(await nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers)
    release()
    await page.goBack()
    await heading(page, 'Dot')
    await page.waitForSelector('.dot svg')
    const error = page.waitForEvent('console', { predicate: message => message.text().includes('Parse dot Error') })
    await page.getByRole('link', { name: 'Invalid' }).click()
    await error
    await heading(page, 'Invalid dot')
    assert.equal(await page.locator('.dot svg').count(), 0)
    await page.getByRole('link', { name: 'Recover' }).click()
    await page.waitForSelector('.dot svg')
  } finally {
    release()
    await page.close()
  }
  console.log('ok - nested diagrams have usable SVG links while other charts load, with history and error recovery')
}

async function assertChartFailureCleanup(browser: Browser, url: string) {
  const page = await browser.newPage()
  // Observe the real library's public registry in the production bundle. A
  // constructor can register itself before throwing, without returning a value.
  await page.route('**/assets/chart-renderer-*.js', async route => {
    const response = await route.fetch()
    const body = await response.text()
    const constructor = /new ([A-Za-z_$][\w$]*)\([^,]+,JSON\.parse\(/.exec(body)?.[1]
    assert.ok(constructor, 'the bundled Chart.js constructor must be observable')
    await route.fulfill({ response, body: `${body}\nwindow.mkdpTestCharts = ${constructor}.instances;` })
  })
  const count = () => page.evaluate(() => Object.keys((window as unknown as { mkdpTestCharts: object }).mkdpTestCharts).length)
  try {
    await page.goto(`${url}?path=${encodeURIComponent(path.join(fixture, 'docs/bad-chart.md'))}`)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByText('"typo" is not a registered controller.', { exact: false }).waitFor()
      assert.equal(await count(), 0, 'failed constructors must not leave a registered Chart instance')
      await page.getByRole('link', { name: 'Leave', exact: true }).click()
      await heading(page, 'No chart')
      assert.equal(await count(), 0)
      if (attempt === 0) await page.getByRole('link', { name: 'Return', exact: true }).click()
    }
  } finally {
    await page.close()
  }
  console.log('ok - invalid chart configurations release partially constructed instances')
}

async function assertMultipleClients(browser: Browser, preview: Awaited<ReturnType<typeof startPreview>>) {
  const { nvim, url } = preview
  await nvim.lua(`
    local opts = require('markdown-preview.config').get()
    opts.refresh = { debounce = 0, events = { 'InsertLeave' } }
    require('markdown-preview').setup(opts)
    require('markdown-preview').open()
    vim.api.nvim_buf_set_lines(0, 0, -1, false, { '# Before' })
  `)
  const first = await browser.newPage()
  const second = await browser.newPage()
  try {
    const connected = first.waitForEvent('websocket')
    await first.goto(url)
    const socket = await connected
    await heading(first, 'Before')
    await nvim.lua(`vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# After' })`)
    await second.goto(url)
    await heading(second, 'After')
    assert.equal((await first.locator('#markdown-body h1').textContent())?.trim(), 'Before')
    const refreshed = socket.waitForEvent('framereceived')
    await nvim.lua(`vim.cmd('doautocmd InsertLeave')`)
    assert.equal(JSON.parse(String((await refreshed).payload)).event, 'refresh_content')
    await heading(first, 'After')
    await heading(second, 'After')
  } finally {
    await first.close()
    await second.close()
  }
  console.log('ok - a new tab snapshot does not suppress the next refresh for existing tabs')
}

let browser: Browser | undefined
let preview: Awaited<ReturnType<typeof startPreview>> | undefined
try {
  browser = await firefox.launch({ headless: true })
  await assertEscapedMarkdown(browser)
  preview = await startPreview(path.join(fixture, 'docs/index.md'), {
    scroll: { throttle: 0 }, render: { mkit: { typographer: false } }
  })
  const { nvim, url } = preview
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  await page.addInitScript(() => {
    let hidden = false
    Object.defineProperty(document, 'hidden', { get: () => hidden })
    ;(window as unknown as { setPreviewHidden: (value: boolean) => void }).setPreviewHidden = value => {
      hidden = value
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })
  const connected = page.waitForEvent('websocket')
  await page.goto(url)
  const socket = await connected
  await heading(page, 'Preview')
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('#markdown-body img')]
    return images.length === 9 && images.every(img => img.complete && img.naturalWidth === 20)
  })
  assert.equal(new URL(await page.locator('img[alt="Fragment"]').getAttribute('src') || '', url).hash, '#icon')
  assert.equal(new URL(await page.locator('img[alt="Query"]').getAttribute('src') || '', url).searchParams.get('cache'), '1')
  assert.equal(await page.locator('img').nth(1).getAttribute('alt'), 'Quoted "alt"')
  const attachment = await page.getByRole('link', { name: 'Open image' }).getAttribute('href')
  assert.equal((await fetch(new URL(attachment!, url))).status, 200)
  console.log('ok - images share local file resolution and preserve URI suffixes and literal filenames')

  await page.getByRole('link', { name: 'Read', exact: true }).click()
  await page.waitForFunction(() => Math.abs(document.getElementById('reading')!.getBoundingClientRect().top) < 2)
  const readingPosition = await page.evaluate(() => window.scrollY)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await frames(page)
  assert.equal(await page.evaluate(() => window.scrollY), readingPosition)
  const setHidden = (hidden: boolean) => page.evaluate(value =>
    (window as unknown as { setPreviewHidden: (value: boolean) => void }).setPreviewHidden(value), hidden)
  await setHidden(true)
  const scroll = socket.waitForEvent('framereceived', { predicate: event => String(event.payload).includes('sync_scroll') })
  await nvim.lua(`vim.api.nvim_win_set_cursor(0, { 1, 0 }); vim.cmd('doautocmd CursorMoved')`)
  await scroll
  await frames(page)
  assert.equal(await page.evaluate(() => window.scrollY), readingPosition)
  await setHidden(false)
  await page.waitForFunction(() => window.scrollY === 0)
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'instant' }))
  await setHidden(false)
  await frames(page)
  assert.equal(await page.evaluate(() => window.scrollY), 400, 'a visibility event must not replay consumed editor scroll')
  console.log('ok - real navigation preserves reading position and consumes queued hidden scroll once')

  await assertChartNavigation(browser, url)
  await assertDotRecovery(browser, preview)
  await assertChartFailureCleanup(browser, url)
  await assertMultipleClients(browser, preview)
} finally {
  await browser?.close()
  await preview?.stop()
  fs.rmSync(fixture, { recursive: true, force: true })
}
