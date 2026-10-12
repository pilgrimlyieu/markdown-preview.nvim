import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DirectoryPage, ProjectPreview } from '../src/project-contract'
import type { PreviewPayload } from '../src/app-contract'
import { startPreview } from './preview-harness'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-project-files-'))
const outside = `${fixture}-outside`
for (const dir of [fixture, outside, path.join(fixture, 'docs'), path.join(fixture, 'many'), path.join(fixture, 'node_modules')]) {
  fs.mkdirSync(dir, { recursive: true })
}
const source = path.join(fixture, 'docs/source.md')
const special = path.join(fixture, 'docs/[draft] # 中文 %.md')
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'
const html = '<script>document.body.dataset.executed = "yes"</script>\n'
fs.writeFileSync(source, '# Source\n')
fs.writeFileSync(special, '# Literal name\n')
fs.writeFileSync(path.join(fixture, '.hidden.md'), '# Hidden\n')
fs.writeFileSync(path.join(fixture, 'node_modules/ignored.md'), '# Ignored\n')
fs.writeFileSync(path.join(outside, 'outside.md'), '# Outside\n')
fs.writeFileSync(path.join(outside, 'tiny.svg'), image.replace('red', 'blue'))
fs.writeFileSync(path.join(fixture, 'tiny.svg'), image)
fs.writeFileSync(path.join(fixture, 'large.svg'), image + ' '.repeat(600))
fs.writeFileSync(path.join(fixture, 'sample.html'), html)
fs.writeFileSync(path.join(fixture, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
fs.writeFileSync(path.join(fixture, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]))
fs.writeFileSync(path.join(fixture, 'empty.txt'), '')
fs.writeFileSync(path.join(fixture, 'small-disk.md'), '# Small on disk\n')
fs.writeFileSync(path.join(fixture, 'large-disk.md'), '# Large on disk\n' + 'x'.repeat(3000))
for (let i = 0; i < 431; i++) fs.writeFileSync(path.join(fixture, 'many', `${String(i).padStart(3, '0')}.md`), '# Page\n')
if (process.platform !== 'win32') {
  fs.symlinkSync(source, path.join(fixture, 'source-alias.md'))
  fs.linkSync(source, path.join(fixture, 'source-hardlink.md'))
  fs.symlinkSync(outside, path.join(fixture, 'outside-link'))
  execFileSync('mkfifo', [path.join(fixture, 'pipe')])
}

let preview: Awaited<ReturnType<typeof startPreview>> | undefined
try {
  preview = await startPreview(source, {
    server: { idle_timeout: 0 }, images_path: outside,
    file_tree: { max_text_bytes: 1024, max_image_bytes: 512 }
  }, fixture)
  const { nvim, bufnr } = preview
  const base = new URL(preview.url).origin
  const url = (kind: string, filename = '', extra: Record<string, string> = {}) =>
    `${base}/api/${kind}/${bufnr}?${new URLSearchParams({ path: filename, ...extra })}`
  const read = async (filename: string) => {
    const response = await fetch(url('preview', filename))
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as ProjectPreview<PreviewPayload>
  }
  const list = async (filename = '', extra: Record<string, string> = {}) => {
    const response = await fetch(url('files', filename, extra))
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as DirectoryPage
  }
  const originalBuffers = await nvim.lua('return vim.api.nvim_list_bufs()')
  const root = await list()
  assert.equal(root.root, fixture, 'the project is the initiating cwd, not the source directory')
  assert.ok(root.entries.some(entry => entry.name === 'docs' && entry.type === 'directory'))
  assert.ok(!root.entries.some(entry => ['node_modules', '.hidden.md'].includes(entry.name)))
  assert.ok((await list('', { hidden: '1' })).entries.some(entry => entry.name === '.hidden.md'))
  assert.ok(!(await list('', { hidden: '1' })).entries.some(entry => entry.name === 'node_modules'))
  const first = await list('many')
  const second = await list('many', { offset: '200' })
  const last = await list('many', { offset: '9999' })
  assert.equal(first.entries.length, 200)
  assert.equal(second.entries.length, 200)
  assert.equal(last.offset, 400)
  assert.equal(last.entries.length, 31)
  assert.equal(new Set([...first.entries, ...second.entries, ...last.entries].map(entry => entry.path)).size, 431)
  assert.equal((await read(special)).kind, 'markdown')
  assert.deepEqual(await nvim.lua('return vim.api.nvim_list_bufs()'), originalBuffers)
  assert.equal(await nvim.lua('return vim.api.nvim_get_current_buf()'), bufnr)
  console.log('ok - project root, literal names, exclusions and directory pages do not load buffers')

  await nvim.lua('vim.cmd.cd(...)', [outside])
  assert.equal((await list()).root, fixture)
  await nvim.lua('require("markdown-preview").open(...)', [bufnr])
  assert.equal((await list()).root, fixture, 'reopening an active preview retains its root')
  await nvim.lua('vim.cmd.cd(...)', [fixture])
  fs.writeFileSync(path.join(fixture, 'new.md'), '# New\n')
  assert.ok((await list('', { fresh: '1' })).entries.some(entry => entry.name === 'new.md'))
  await nvim.lua('require("markdown-preview.config").get().file_tree.max_entries = 10')
  const limited = await list('many', { fresh: '1' })
  assert.equal(limited.truncated, true)
  assert.equal(limited.total, 10)
  await nvim.lua('require("markdown-preview.config").get().file_tree.max_entries = 20000')
  console.log('ok - roots survive cd/reopen, refreshing sees new files and enumeration has a work limit')

  await nvim.lua(`
    local fixture = ...
    for name, lines in pairs({
      ['small-disk.md'] = { string.rep('x', 3000) },
      ['large-disk.md'] = { '# Small unsaved buffer' },
    }) do
      local buffer = vim.fn.bufadd(fixture .. '/' .. name)
      vim.fn.bufload(buffer)
      vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    end
    vim.api.nvim_buf_set_lines(0, 0, -1, false, { '# Large live source', string.rep('x', 3000) })
  `, [fixture])
  const smallDisk = await read('small-disk.md')
  assert.equal(smallDisk.kind, 'attachment')
  if (smallDisk.kind !== 'source') assert.match(smallDisk.payload.file?.kind === 'attachment' ? smallDisk.payload.file.message : '', /loaded buffer/)
  const largeDisk = await read('large-disk.md')
  assert.equal(largeDisk.kind, 'markdown')
  if (largeDisk.kind !== 'source') assert.deepEqual(largeDisk.payload.content, ['# Small unsaved buffer'])
  for (const filename of process.platform === 'win32' ? [source] : [source, 'source-alias.md', 'source-hardlink.md']) {
    assert.deepEqual(await read(filename), { kind: 'source', path: null }, 'source identity takes priority over the reading size limit')
  }
  const sourceSnapshot = await (await fetch(url('source'))).json() as { payload: PreviewPayload }
  assert.equal(sourceSnapshot.payload.content?.[0], '# Large live source')
  assert.equal(sourceSnapshot.payload.content?.[1].length, 3000)
  console.log('ok - unsaved buffer limits use memory size and source aliases keep the live preview contract')

  const text = await read('sample.html')
  assert.equal(text.kind, 'text')
  if (text.kind !== 'source') assert.equal(text.payload.content?.join('\n'), html)
  assert.equal((await read('binary.bin')).kind, 'attachment')
  assert.equal((await read('invalid-utf8.txt')).kind, 'attachment')
  assert.equal((await read('empty.txt')).kind, 'text')
  const picture = await read('tiny.svg')
  assert.equal(picture.kind, 'image')
  if (picture.kind !== 'source' && picture.payload.file?.kind === 'image') {
    const response = await fetch(new URL(picture.payload.file.url, base))
    assert.equal(await response.text(), image, 'selected pictures must ignore images_path')
  } else assert.fail('missing image URL')
  assert.equal((await read('large.svg')).kind, 'attachment')
  assert.equal((await fetch(url('resource', 'large.svg'))).status, 413)
  const largeDownload = await fetch(url('resource', 'large.svg', { download: '1' }))
  assert.equal(largeDownload.status, 200)
  assert.match(largeDownload.headers.get('content-disposition') || '', /^attachment;/)
  assert.equal((await largeDownload.text()).length, image.length + 600)
  const htmlDownload = await fetch(url('resource', 'sample.html'))
  assert.match(htmlDownload.headers.get('content-disposition') || '', /^attachment;/)
  assert.equal(htmlDownload.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await htmlDownload.text(), html)
  const partial = await fetch(url('resource', 'sample.html', { download: '1' }), { headers: { range: 'bytes=2-8' } })
  assert.equal(partial.status, 206)
  assert.equal(await partial.text(), html.slice(2, 9))
  assert.equal((await fetch(url('resource', 'empty.txt'), { method: 'HEAD' })).headers.get('content-length'), '0')
  assert.equal((await fetch(url('resource', 'sample.html'), { headers: { range: 'bytes=99999-' } })).status, 416)
  console.log('ok - text and image readers enforce limits; resource bytes, safe downloads and ranges work')

  for (const kind of ['files', 'preview', 'resource']) {
    assert.equal((await fetch(url(kind, path.join(outside, 'outside.md')))).status, 403)
    assert.equal((await fetch(url(kind, `../${path.basename(outside)}/outside.md`))).status, 403)
  }
  assert.equal((await fetch(url('preview', 'missing.md'))).status, 404)
  assert.equal((await fetch(url('preview', '\0'))).status, 400)
  assert.equal((await fetch(url('files', '', { offset: '-1' }))).status, 400)
  assert.equal((await fetch(`${base}/api/files/999999`)).status, 404)
  assert.equal((await fetch(url('files'), { method: 'POST' })).status, 405)
  if (process.platform !== 'win32') {
    assert.equal((await list()).entries.find(entry => entry.name === 'outside-link')?.type, 'unavailable')
    assert.equal((await fetch(url('preview', 'outside-link/outside.md'))).status, 403)
    for (const kind of ['preview', 'resource']) {
      assert.equal((await fetch(url(kind, 'pipe'), { signal: AbortSignal.timeout(2000) })).status, 404)
    }
  }
  // The explicit legacy link contract intentionally still permits outside paths.
  assert.equal((await fetch(`${base}/api/document/${bufnr}?${new URLSearchParams({ path: path.join(outside, 'outside.md') })}`)).status, 200)
  console.log('ok - new endpoints reject out-of-root paths and special files without changing legacy links')

  await nvim.lua('vim.cmd.vnew(); vim.cmd.lcd(...)', [outside])
  const other = await preview.open(path.join(outside, 'outside.md'))
  assert.equal(new URL(other.url).origin, base)
  assert.equal((await (await fetch(`${base}/api/files/${other.bufnr}`)).json()).root, outside)
  assert.equal((await list()).root, fixture)
  await nvim.lua('require("markdown-preview").stop(...)', [bufnr])
  assert.equal((await fetch(url('files'))).status, 404, 'a buffer that still exists must not keep a stopped preview root')
  const reopened = await preview.open(source)
  assert.equal(reopened.bufnr, bufnr)
  assert.equal((await list()).root, outside, 'a new lifetime captures the initiating window local cwd')
  console.log('ok - local window roots, shared servers and stopped/reopened preview lifetimes stay independent')
} finally {
  await preview?.stop()
  fs.rmSync(fixture, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
}
