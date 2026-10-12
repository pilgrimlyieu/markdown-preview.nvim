import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { firefox } from 'playwright-core'
import type { Page } from 'playwright-core'
import { startPreview } from './preview-harness'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-preview-links-'))
fs.mkdirSync(path.join(fixture, 'docs/child'), { recursive: true })
const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.\n`).join('\n')
const source = [
  '# Home',
  '[External](https://example.com/)',
  '[Protocol relative](//example.com/protocol)',
  '[Anchor](#原文位置)',
  '[Other](docs/other.md#目标章节)',
  '[Unicode](docs/中文%20空格.md)',
  '[Percent](docs/literal%2520name.md)',
  '[Unsaved](docs/unsaved.md)',
  '[Bracket filename](docs/real%5Bab%5D.md)',
  '[Source alias](alias.md)',
  '[Source hardlink](hardlink.md)',
  '[Attachment](docs/note.txt)',
  '[Missing](missing.md)',
  '[Temporary](docs/temporary.md)',
  '<a href="docs/note.txt" download>Download</a>',
  '<a href="https://example.com/explicit" target="_self">Explicit target</a>',
  filler,
  '## 原文位置',
  '[Read from here](docs/other.md#目标章节)',
  '[Missing heading](docs/other.md#does-not-exist)',
  filler
].join('\n\n')
fs.writeFileSync(path.join(fixture, 'index.md'), source)
fs.symlinkSync(path.join(fixture, 'index.md'), path.join(fixture, 'alias.md'))
fs.linkSync(path.join(fixture, 'index.md'), path.join(fixture, 'hardlink.md'))
fs.writeFileSync(path.join(fixture, 'docs/other.md'), [
  '# Other',
  '[Home link](../index.md#原文位置)',
  '[Nested](child/next.MD)',
  '[Missing](missing.md)',
  '<a href="../index.md">HTML home</a>',
  '![Local image](tiny.svg)',
  '$x^2$',
  filler,
  '## 目标章节',
  filler
].join('\n\n'))
fs.writeFileSync(path.join(fixture, 'docs/child/next.MD'), '# Nested\n\n[Parent](../other.md)\n')
fs.writeFileSync(path.join(fixture, 'docs/中文 空格.md'), '# Unicode filename\n')
fs.writeFileSync(path.join(fixture, 'docs/literal%20name.md'), '# Literal percent filename\n')
fs.writeFileSync(path.join(fixture, 'docs/unsaved.md'), '# Saved on disk\n')
fs.writeFileSync(path.join(fixture, 'docs/reala.md'), '# Saved reala\n')
fs.writeFileSync(path.join(fixture, 'docs/real[ab].md'), '# Exact bracket target\n')
fs.writeFileSync(path.join(fixture, 'docs/temporary.md'), '# Temporary\n')
fs.writeFileSync(path.join(fixture, 'docs/note.txt'), 'A local attachment.\n')
fs.writeFileSync(path.join(fixture, 'docs/tiny.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>')

let preview: Awaited<ReturnType<typeof startPreview>> | undefined
let browser: Awaited<ReturnType<typeof firefox.launch>> | undefined

async function heading(page: Page, title: string) {
  await page.waitForFunction(text => document.querySelector('#markdown-body h1')?.textContent?.trim() === text, title)
}

async function atAnchor(page: Page, title: string) {
  await page.waitForFunction(text => {
    const anchor = document.getElementById(encodeURIComponent(text)) || document.getElementById(text)
    return anchor && Math.abs(anchor.getBoundingClientRect().top) < 2
  }, title)
}

async function flushFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

try {
  preview = await startPreview(path.join(fixture, 'index.md'), { scroll: { throttle: 0 } })
  const { nvim, bufnr, url } = preview
  await nvim.lua(`
    local fixture = ...
    local unsaved = vim.fn.bufadd(fixture .. '/docs/unsaved.md')
    vim.fn.bufload(unsaved)
    vim.api.nvim_buf_set_lines(unsaved, 0, -1, false, { '# Unsaved buffer' })
    local pattern_match = vim.fn.bufadd(fixture .. '/docs/reala.md')
    vim.fn.bufload(pattern_match)
    vim.api.nvim_buf_set_lines(pattern_match, 0, -1, false, { '# Wrong pattern match' })
  `, [fixture])
  const originalBuffers = await nvim.lua('return vim.api.nvim_list_bufs()')
  const base = new URL(url).origin

  browser = await firefox.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  await context.route(/^https?:\/\/example\.com\//, route => route.fulfill({
    contentType: 'text/html', body: '<h1>External page</h1>'
  }))
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const connected = page.waitForEvent('websocket')
  await page.goto(url + '#原文位置')
  let socket = await connected
  await heading(page, 'Home')
  await atAnchor(page, '原文位置')
  assert.equal(decodeURIComponent(new URL(page.url()).hash), '#原文位置')
  const unchanged = socket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('refresh_content')
  })
  await nvim.lua(`
    local bufnr = vim.api.nvim_get_current_buf()
    local payload = require('markdown-preview.preview').payload(bufnr, true)
    payload.changedtick = nil
    require('markdown-preview.server').notify(bufnr, 'refresh_content', { bufnr = bufnr, data = payload })
  `)
  await unchanged
  await flushFrames(page)
  await atAnchor(page, '原文位置')
  console.log('ok - initial Unicode fragments survive connection and render')

  await page.getByRole('link', { name: 'Read from here', exact: true }).scrollIntoViewIfNeeded()
  const originalScroll = await page.evaluate(() => window.scrollY)
  await page.getByRole('link', { name: 'Read from here', exact: true }).click()
  await heading(page, 'Other')
  await page.waitForSelector('.katex')
  await atAnchor(page, '目标章节')
  assert.equal(context.pages().length, 1)
  assert.equal(await nvim.lua('return vim.api.nvim_get_current_buf()'), bufnr)
  assert.deepEqual(await nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers,
    'reading an unopened file must not add a Neovim buffer')
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Local image"]')
    return image?.complete && image.naturalWidth === 20
  })
  assert.equal(new URL(page.url()).searchParams.get('path'), path.join(fixture, 'docs/other.md'))
  console.log('ok - local Markdown, async math anchors and relative images render without changing Neovim')

  const readingScroll = await page.evaluate(() => window.scrollY)
  const refreshed = socket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('Home edited')
  })
  await nvim.lua(`
    vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# Home edited' })
    vim.cmd('doautocmd TextChanged')
  `)
  await refreshed
  const scrolled = socket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('sync_scroll')
  })
  await nvim.lua(`vim.api.nvim_win_set_cursor(0, { 2, 0 }); vim.cmd('doautocmd CursorMoved')`)
  await scrolled
  await flushFrames(page)
  await heading(page, 'Other')
  assert.equal(await page.evaluate(() => window.scrollY), readingScroll)

  await page.goBack()
  await heading(page, 'Home edited')
  await page.waitForFunction(top => Math.abs(window.scrollY - top) < 2, originalScroll)
  await page.goForward()
  await heading(page, 'Other')
  await page.waitForFunction(top => Math.abs(window.scrollY - top) < 2, readingScroll)
  console.log('ok - editor events leave reading alone; back and forward restore content and viewport')

  const otherUrl = page.url()
  const reconnected = page.waitForEvent('websocket')
  await page.reload()
  socket = await reconnected
  await heading(page, 'Other')
  await page.waitForFunction(top => Math.abs(window.scrollY - top) < 2, readingScroll)
  assert.equal(page.url(), otherUrl)
  await page.getByRole('link', { name: 'Nested', exact: true }).click()
  await heading(page, 'Nested')
  await page.getByRole('link', { name: 'Parent', exact: true }).click()
  await heading(page, 'Other')
  await page.getByRole('link', { name: 'HTML home', exact: true }).click()
  await heading(page, 'Home edited')
  assert.equal(new URL(page.url()).searchParams.get('path'), null, 'a link to the source should resume live preview')
  console.log('ok - reloads, nested paths and HTML links retain the correct document base')

  for (const [link, title] of [
    ['Unicode', 'Unicode filename'],
    ['Percent', 'Literal percent filename'],
    ['Unsaved', 'Unsaved buffer'],
    ['Bracket filename', 'Exact bracket target']
  ]) {
    await page.getByRole('link', { name: link, exact: true }).click()
    await heading(page, title)
    await page.goBack()
    await heading(page, 'Home edited')
  }
  console.log('ok - Unicode, spaces, percent escapes and unsaved buffers are read correctly')
  fs.unlinkSync(path.join(fixture, 'docs/real[ab].md'))
  const missingBracket = await fetch(`${base}/api/document/${bufnr}?path=docs/real%5Bab%5D.md`)
  assert.equal(missingBracket.status, 404, 'a missing filename must not match a different loaded buffer')
  console.log('ok - filenames are matched exactly, including when the target does not exist')

  await page.getByRole('link', { name: 'Missing heading', exact: true }).click()
  await heading(page, 'Other')
  await page.waitForFunction(() => window.scrollY === 0)
  await page.goBack()
  await heading(page, 'Home edited')

  let releaseSlow!: () => void
  let markStarted!: () => void
  let markFinished!: () => void
  const released = new Promise<void>(resolve => { releaseSlow = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const finished = new Promise<void>(resolve => { markFinished = resolve })
  await page.route(`**/api/document/${bufnr}?*`, async route => {
    const response = await route.fetch()
    markStarted()
    await released
    // The older navigation was deliberately aborted by the second click.
    await route.fulfill({ response }).catch(() => {})
    markFinished()
  }, { times: 1 })
  await page.getByRole('link', { name: 'Other', exact: true }).click()
  await started
  await page.getByRole('link', { name: 'Unicode', exact: true }).click()
  await heading(page, 'Unicode filename')
  releaseSlow()
  await finished
  await flushFrames(page)
  await heading(page, 'Unicode filename')
  await page.goBack()
  await heading(page, 'Home edited')
  console.log('ok - a late response cannot replace a more recent navigation')

  const beforeTemporary = page.url()
  await page.getByRole('link', { name: 'Temporary', exact: true }).click()
  await heading(page, 'Temporary')
  await page.goBack()
  await heading(page, 'Home edited')
  fs.unlinkSync(path.join(fixture, 'docs/temporary.md'))
  await page.goForward()
  await page.locator('#preview-message').waitFor({ state: 'visible' })
  await heading(page, 'Home edited')
  assert.equal(page.url(), beforeTemporary)
  await page.getByRole('button', { name: 'Dismiss message' }).click()
  console.log('ok - a deleted history destination leaves the current preview usable')

  const homeUrl = page.url()
  const historyLength = await page.evaluate(() => window.history.length)
  await page.getByRole('link', { name: 'Missing', exact: true }).click()
  await page.locator('#preview-message').waitFor({ state: 'visible' })
  assert.match(await page.locator('#preview-message').textContent() || '', /Cannot open local file/)
  assert.equal(page.url(), homeUrl)
  assert.equal(await page.evaluate(() => window.history.length), historyLength)
  await heading(page, 'Home edited')
  await page.getByRole('button', { name: 'Dismiss message' }).click()
  console.log('ok - missing files show a dismissible error without losing the current page')

  for (const name of ['External', 'Protocol relative', 'Attachment']) {
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('link', { name, exact: true }).click()
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    assert.equal(page.url(), homeUrl)
    assert.equal(await popup.evaluate(() => window.opener), null)
    if (name === 'Attachment') assert.match(await popup.locator('body').textContent() || '', /A local attachment/)
    await popup.close()
    await page.bringToFront()
  }
  assert.equal(await page.getByRole('link', { name: 'Explicit target', exact: true }).getAttribute('target'), '_self')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download', exact: true }).click()
  const download = await downloadPromise
  assert.equal(await download.failure(), null)
  assert.equal(download.suggestedFilename(), 'note.txt')
  assert.equal(page.url(), homeUrl)
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Other', exact: true }).click({ button: 'middle' })
  const popup = await popupPromise
  await heading(popup, 'Other')
  await atAnchor(popup, '目标章节')
  await popup.close()
  await page.bringToFront()
  console.log('ok - external links, attachments, downloads and middle clicks preserve the source tab')

  const badPath = await fetch(`${base}/api/document/${bufnr}?path=${encodeURIComponent('bad\0.md')}`)
  assert.equal(badPath.status, 400)
  const directory = await fetch(`${base}/file/${bufnr}?path=docs`)
  assert.equal(directory.status, 404)
  const nonMarkdown = await fetch(`${base}/api/document/${bufnr}?path=docs/note.txt`)
  assert.equal(nonMarkdown.status, 400)
  const missing = await fetch(`${base}/api/document/${bufnr}?path=absent.md`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'no-store')
  const invalidImage = await fetch(`${base}/_local_image_tiny.svg?document=${encodeURIComponent('bad\0.md')}`, {
    headers: { referer: url }
  })
  assert.equal(invalidImage.status, 404)

  const finalRefresh = socket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('Still live')
  })
  await nvim.lua(`vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# Still live' }); vim.cmd('doautocmd TextChanged')`)
  await finalRefresh
  await heading(page, 'Still live')
  assert.equal(await nvim.lua('return vim.api.nvim_get_current_buf()'), bufnr)
  assert.deepEqual(await nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers)
  console.log('ok - invalid routes fail cleanly and the original preview remains live')

  await page.getByRole('link', { name: 'Other', exact: true }).click()
  await heading(page, 'Other')
  let releaseSnapshot!: () => void
  let markSnapshotCaptured!: () => void
  const snapshotReleased = new Promise<void>(resolve => { releaseSnapshot = resolve })
  const snapshotCaptured = new Promise<void>(resolve => { markSnapshotCaptured = resolve })
  await page.route(`**/api/document/${bufnr}?*`, async route => {
    const response = await route.fetch()
    markSnapshotCaptured()
    await snapshotReleased
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('link', { name: 'Home link', exact: true }).click()
  await snapshotCaptured
  const newerSource = socket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('Newest source')
  })
  await nvim.lua(`vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# Newest source' }); vim.cmd('doautocmd TextChanged')`)
  await newerSource
  releaseSnapshot()
  await heading(page, 'Newest source')
  assert.equal(new URL(page.url()).searchParams.get('path'), null)
  console.log('ok - returning to the source keeps newer WebSocket content over an older HTTP snapshot')

  for (const [name, title] of [['Source alias', 'Live through symlink'], ['Source hardlink', 'Live through hardlink']]) {
    const aliasResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/document/${bufnr}`)
    await page.getByRole('link', { name, exact: true }).click()
    const document = await (await aliasResponse).json()
    assert.equal(document.path, null, 'an alias of the source must resume live preview')
    assert.deepEqual(document.payload.content, await nvim.lua('return vim.api.nvim_buf_get_lines(0, 0, -1, false)'),
      'file aliases must read the loaded buffer, including unsaved changes')
    const aliasRefresh = socket.waitForEvent('framereceived', {
      predicate: event => String(event.payload).includes(title)
    })
    await nvim.lua(`vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# ' .. (...) }); vim.cmd('doautocmd TextChanged')`, [title])
    await aliasRefresh
    await heading(page, title)
    assert.equal(new URL(page.url()).searchParams.get('path'), null)
  }
  assert.equal(await nvim.lua('return vim.api.nvim_get_current_buf()'), bufnr)
  assert.deepEqual(await nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers)
  console.log('ok - source symlinks and hardlinks resume unsaved content and live updates')

  const combinedConnection = page.waitForEvent('websocket')
  await nvim.lua(`
    local fixture, content = ...
    local opts = require('markdown-preview.config').get()
    opts.combine.enabled = true
    require('markdown-preview').setup(opts)
    local target = vim.fn.bufnr(fixture .. '/docs/unsaved.md')
    vim.api.nvim_buf_set_lines(target, 0, -1, false, vim.split('# Combined\\n\\n[Read linked document](other.md)\\n\\n' .. content, '\\n'))
    vim.api.nvim_set_current_buf(target)
    vim.api.nvim_win_set_cursor(0, { 70, 0 })
  `, [fixture, filler])
  await heading(page, 'Combined')
  const combinedSocket = await combinedConnection
  await page.waitForFunction(() => window.scrollY > 500)
  const combinedRefresh = combinedSocket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('Combined edited')
  })
  await nvim.lua(`vim.api.nvim_buf_set_lines(0, 0, 1, false, { '# Combined edited' }); vim.cmd('doautocmd TextChanged')`)
  await combinedRefresh
  await heading(page, 'Combined edited')
  assert.deepEqual(errors, [])
  console.log('ok - automatic combined previews subscribe to the new buffer and keep updating')

  const readingOwner = await nvim.lua('return vim.api.nvim_get_current_buf()') as number
  await page.getByRole('link', { name: 'Read linked document', exact: true }).click()
  await heading(page, 'Other')
  const ignoredSwitch = combinedSocket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('change_bufnr')
  })
  await nvim.lua('vim.api.nvim_set_current_buf(...)', [bufnr])
  await ignoredSwitch
  await flushFrames(page)
  await heading(page, 'Other')
  assert.equal(new URL(page.url()).pathname, `/page/${readingOwner}`,
    'reading a linked document must retain its original buffer subscription')
  const closeMessage = combinedSocket.waitForEvent('framereceived', {
    predicate: event => String(event.payload).includes('close_page')
  })
  await nvim.lua('vim.api.nvim_buf_delete(..., { force = true })', [readingOwner])
  await closeMessage
  assert.equal(await nvim.lua('return require("markdown-preview").is_active(...)', [readingOwner]), false)
  console.log('ok - deleting a combined preview source closes its linked reading page after an ignored switch')
} finally {
  await browser?.close()
  await preview?.stop()
  fs.rmSync(fixture, { recursive: true, force: true })
}
