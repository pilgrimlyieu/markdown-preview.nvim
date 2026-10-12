import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startPreview } from './preview-harness'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-lifecycle-'))
for (const name of ['a', 'b']) fs.writeFileSync(path.join(fixture, `${name}.md`), `# ${name}\n`)
const filename = (name: string) => path.join(fixture, `${name}.md`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function eventually(check: () => unknown | Promise<unknown>, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  assert.fail(message)
}

function connect(url: string) {
  const address = new URL(url)
  const bufnr = address.pathname.split('/').pop()!
  address.protocol = 'ws:'
  address.pathname = '/ws'
  address.search = `bufnr=${bufnr}`
  const socket = new WebSocket(address)
  const messages: Array<{ event: string, data?: { content?: string[] } }> = []
  socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
  return { socket, messages }
}

async function assertSharedPreviews() {
  const preview = await startPreview(filename('a'), { server: { idle_timeout: 0 }, refresh: { debounce: 10 } })
  const first = connect(preview.url)
  let second: ReturnType<typeof connect> | undefined
  try {
    await eventually(() => first.messages.length, 'first preview should receive its content')
    const other = await preview.open(filename('b'))
    second = connect(other.url)
    await eventually(() => second!.messages.length, 'second preview should receive its content')
    assert.equal(new URL(other.url).origin, new URL(preview.url).origin, 'previews must share a server and asset origin')
    const channels = await preview.nvim.lua(`
      local a, b = ...
      local server = require('markdown-preview.server')
      return { server.channel(a), server.channel(b) }
    `, [preview.bufnr, other.bufnr]) as number[]
    assert.equal(channels[0], channels[1], 'both buffers must use the same RPC job')
    await preview.nvim.lua(`
      local bufnr = ...
      vim.api.nvim_set_current_buf(bufnr)
      vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { '# A edited' })
      vim.cmd('doautocmd TextChanged')
    `, [preview.bufnr])
    await eventually(() => first.messages.some(message => message.data?.content?.[0] === '# A edited'),
      'the first preview must stay live after opening the second')
    assert.ok(!second.messages.some(message => message.data?.content?.[0] === '# A edited'),
      'one buffer must not receive another buffer\'s content')
    await preview.nvim.lua('require("markdown-preview").stop(...)', [preview.bufnr])
    assert.equal(await preview.nvim.lua('return require("markdown-preview").is_active(...)', [other.bufnr]), true,
      'stopping one preview must leave the other active')
    await preview.nvim.lua(`
      local bufnr = ...
      vim.api.nvim_set_current_buf(bufnr)
      vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, { '# B edited' })
      vim.cmd('doautocmd TextChanged')
    `, [other.bufnr])
    await eventually(() => second!.messages.some(message => message.data?.content?.[0] === '# B edited'),
      'the second preview must still receive edits after stopping the first')
    await preview.nvim.lua('require("markdown-preview").stop(...)', [other.bufnr])
    await eventually(async () => await preview.nvim.lua('return require("markdown-preview.server").channel(...)',
      [other.bufnr]) === null, 'stopping the last preview must release the shared runtime')
  } finally {
    first.socket.close()
    second?.socket.close()
    await preview.stop()
  }
}

async function assertBufferRemoval(perBuffer: boolean, command: string) {
  const preview = await startPreview(filename('a'), { server: { per_buffer: perBuffer, idle_timeout: 0 } })
  try {
    const channel = await preview.nvim.lua('return require("markdown-preview.server").channel(...)', [preview.bufnr])
    await preview.nvim.lua(`vim.cmd('enew')`)
    assert.equal(await preview.nvim.lua('return require("markdown-preview").is_active(...)', [preview.bufnr]), true,
      'auto_close=false must preserve a preview when its buffer is only hidden')
    await preview.nvim.lua('local command, bufnr = ...; vim.cmd(command .. "! " .. bufnr)', [command, preview.bufnr])
    await eventually(async () => await preview.nvim.lua('return require("markdown-preview").is_active(...)',
      [preview.bufnr]) === false, `${command} must deactivate the removed buffer`)
    await eventually(async () => await preview.nvim.lua('local channel = ...; return vim.fn.jobwait({ channel }, 0)[1]',
      [channel]) !== -1, `${command} must terminate the unused runtime`)
  } finally {
    await preview.stop()
  }
}

async function assertQueuedOpens() {
  const preview = await startPreview(filename('a'), { server: { idle_timeout: 0 } })
  try {
    await preview.nvim.lua(`
      local filename = ...
      require('markdown-preview').stop()
      vim.g.mkdp_test_urls = {}
      require('markdown-preview.config').get().browser = function(url)
        local urls = vim.g.mkdp_test_urls
        table.insert(urls, url)
        vim.g.mkdp_test_urls = urls
      end
      require('markdown-preview').open()
      vim.cmd('edit ' .. vim.fn.fnameescape(filename))
      require('markdown-preview').open()
    `, [filename('b')])
    await eventually(async () => (await preview.nvim.lua('return vim.g.mkdp_test_urls') as string[]).length === 2,
      'opening two buffers before the shared server is ready must preserve both requests')
    const urls = await preview.nvim.lua('return vim.g.mkdp_test_urls') as string[]
    assert.equal(new Set(urls.map(url => new URL(url).origin)).size, 1)
    assert.equal(new Set(urls).size, 2)
  } finally {
    await preview.stop()
  }
}

async function assertCancelledOpens() {
  const preview = await startPreview(filename('a'), { server: { idle_timeout: 0 } })
  try {
    const other = await preview.nvim.lua(`
      local filename, first = ...
      vim.g.mkdp_test_urls = {}
      require('markdown-preview.config').get().browser = function(url)
        local urls = vim.g.mkdp_test_urls
        table.insert(urls, url)
        vim.g.mkdp_test_urls = urls
      end
      vim.cmd('edit ' .. vim.fn.fnameescape(filename))
      local other = vim.api.nvim_get_current_buf()
      require('markdown-preview').open(other)
      require('markdown-preview').stop(other)
      -- This final open is a completion barrier for the preceding RPCs.
      require('markdown-preview').open(first)
      return other
    `, [filename('b'), preview.bufnr]) as number
    await eventually(async () => (await preview.nvim.lua('return vim.g.mkdp_test_urls') as string[])
      .some(url => url.endsWith(`/page/${preview.bufnr}`)), 'the later valid request should open')
    const urls = await preview.nvim.lua('return vim.g.mkdp_test_urls') as string[]
    assert.equal(urls.length, 1, 'stopping a buffer must cancel its in-flight browser request')
    const stopped = connect(`${new URL(preview.url).origin}/page/${other}`)
    try {
      await eventually(() => stopped.socket.readyState === WebSocket.CLOSED,
        'a stopped preview must reject stale browser connections')
      assert.ok(!stopped.messages.some(message => message.event === 'refresh_content'))
    } finally {
      stopped.socket.close()
    }
    await preview.nvim.lua(`
      local other, first = ...
      vim.g.mkdp_test_urls = {}
      require('markdown-preview').open(other)
      require('markdown-preview').stop(other)
      require('markdown-preview').open(other)
      require('markdown-preview').open(first)
    `, [other, preview.bufnr])
    await eventually(async () => (await preview.nvim.lua('return vim.g.mkdp_test_urls') as string[])
      .some(url => url.endsWith(`/page/${preview.bufnr}`)), 'the reopen sequence should finish')
    const reopened = await preview.nvim.lua('return vim.g.mkdp_test_urls') as string[]
    assert.equal(reopened.filter(url => url.endsWith(`/page/${other}`)).length, 1,
      'a later open of the same buffer must not revive an older request')
  } finally {
    await preview.stop()
  }
}

async function assertIdleShutdown() {
  const timeout = 400
  const preview = await startPreview(filename('a'), { server: { idle_timeout: timeout } })
  const first = connect(preview.url)
  let second: ReturnType<typeof connect> | undefined
  let reconnected: ReturnType<typeof connect> | undefined
  try {
    await eventually(() => first.messages.length, 'first browser should connect')
    const other = await preview.open(filename('b'))
    second = connect(other.url)
    await eventually(() => second!.messages.length, 'second browser should connect')
    const channel = await preview.nvim.lua('return require("markdown-preview.server").channel(...)', [preview.bufnr])
    first.socket.close()
    await sleep(timeout + 100)
    assert.equal(await preview.nvim.lua('return require("markdown-preview.server").channel(...)', [other.bufnr]), channel,
      'another browser connection must keep the shared server alive')
    second.socket.close()
    reconnected = connect(other.url)
    await eventually(() => reconnected!.messages.length, 'reload should reconnect during the grace period')
    await sleep(timeout + 100)
    assert.equal(await preview.nvim.lua('return require("markdown-preview.server").channel(...)', [other.bufnr]), channel,
      'reconnection must cancel the pending shutdown')
    reconnected.socket.close()
    await eventually(async () => await preview.nvim.lua('return require("markdown-preview.server").channel(...)',
      [other.bufnr]) === null, 'the server must exit after its last browser disconnects')
    assert.equal(await preview.nvim.lua('return require("markdown-preview").is_active(...)', [preview.bufnr]), false)
    assert.equal(await preview.nvim.lua('return require("markdown-preview").is_active(...)', [other.bufnr]), false)
    await preview.open(filename('a'))
    assert.equal(await preview.nvim.lua('return require("markdown-preview").is_active()'), true,
      'an idle preview must be restartable')
  } finally {
    first.socket.close()
    second?.socket.close()
    reconnected?.socket.close()
    await preview.stop()
  }
}

async function assertUnopenedShutdown() {
  const preview = await startPreview(filename('a'), { server: { idle_timeout: 150 } })
  try {
    await eventually(async () => await preview.nvim.lua('return require("markdown-preview.server").channel(...)',
      [preview.bufnr]) === null, 'a URL that never connects must not leave a runtime behind')
  } finally {
    await preview.stop()
  }
}

async function assertCombinedStop() {
  const preview = await startPreview(filename('a'), { server: { idle_timeout: 0 }, combine: { enabled: true } })
  const first = connect(preview.url)
  let second: ReturnType<typeof connect> | undefined
  try {
    await eventually(() => first.messages.length, 'combined preview should connect')
    const bufnr = await preview.nvim.lua(`
      vim.cmd('edit ' .. vim.fn.fnameescape(...))
      return vim.api.nvim_get_current_buf()
    `, [filename('b')]) as number
    await eventually(() => first.messages.some(message => message.event === 'change_bufnr'),
      'entering another buffer should retarget the combined preview')
    second = connect(`${new URL(preview.url).origin}/page/${bufnr}`)
    await eventually(() => second!.messages.length, 'combined preview should connect to its new buffer')
    first.socket.close()
    await preview.nvim.lua('require("markdown-preview").stop()')
    assert.equal(await preview.nvim.lua('return require("markdown-preview").is_active(...)', [preview.bufnr]), false,
      'the previous combined buffer must not retain an active preview')
    assert.equal(await preview.nvim.lua('return require("markdown-preview.server").channel(...)', [bufnr]), null,
      'stopping the single combined preview must release its server immediately')
  } finally {
    first.socket.close()
    second?.socket.close()
    await preview.stop()
  }
}

async function assertEditorExit() {
  const preview = await startPreview(filename('a'), { server: { idle_timeout: 0 } })
  const browser = connect(preview.url)
  const [editorPid, serverPid] = await preview.nvim.lua(`
    local channel = require('markdown-preview.server').channel(vim.api.nvim_get_current_buf())
    return { vim.fn.getpid(), vim.fn.jobpid(channel) }
  `) as number[]
  const serverRunning = () => {
    try {
      process.kill(serverPid, 0)
      // A terminated grandchild can briefly await reaping after its parent dies.
      return process.platform !== 'linux' ||
        !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${serverPid}/status`, 'utf8'))
    } catch { return false }
  }
  try {
    await eventually(() => browser.messages.length, 'browser should connect before the editor exits')
    process.kill(editorPid, 'SIGKILL')
    await eventually(() => !serverRunning(), 'an editor crash must release its server even with an open browser')
  } finally {
    browser.socket.close()
    if (serverRunning()) process.kill(serverPid, 'SIGTERM')
    await preview.stop()
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ['shared previews update and stop independently', assertSharedPreviews],
  ...[false, true].flatMap(perBuffer => ['bdelete', 'bwipeout', 'bunload'].map(command =>
    [`${command} releases ${perBuffer ? 'isolated' : 'shared'} servers`,
      () => assertBufferRemoval(perBuffer, command)] as [string, () => Promise<void>])),
  ['rapid opens wait for server readiness', assertQueuedOpens],
  ['stopped and superseded opens are cancelled', assertCancelledOpens],
  ['stopping a combined preview releases its shared server', assertCombinedStop],
  ['idle shutdown respects other pages and reconnects', assertIdleShutdown],
  ['unopened previews expire', assertUnopenedShutdown],
  ['editor crashes release the preview server', assertEditorExit]
]

try {
  for (const [name, test] of tests) {
    if (process.argv[2] && !name.includes(process.argv[2])) continue
    await test()
    console.log(`ok - ${name}`)
  }
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
