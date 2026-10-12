import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { attach } from '@chemzqm/neovim'
import type { VimValue } from '@chemzqm/neovim'

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Use the public setup/open path, including filetype detection and BufEnter. */
export async function startPreview(filename: string, options: Record<string, VimValue> = {}, cwd?: string) {
  assert.ok(fs.existsSync(path.join(repositoryRoot, 'app/out/index.html')), 'run bun run build-local first')
  const editor = spawn('nvim', ['--headless', '--embed', '-u', 'NONE', '-i', 'NONE', '-n'], { stdio: 'pipe', cwd })
  // The client calls unpipe() when detaching; Bun's child stdin is only Writable.
  const input = new PassThrough()
  input.pipe(editor.stdin)
  const nvim = attach({ reader: editor.stdout, writer: input })
  let stderr = ''
  editor.stderr.on('data', chunk => { stderr += String(chunk) })
  const exited = new Promise<void>(resolve => editor.once('close', () => resolve()))
  const stop = async () => {
    if (editor.exitCode === null && editor.signalCode === null) {
      await nvim.lua('pcall(function() require("markdown-preview").stop() end)').catch(() => {})
      editor.kill()
    }
    await exited
    input.destroy()
  }
  const open = async (filename: string) => {
    const bufnr = await nvim.lua(`
      local filename = ...
      vim.g.mkdp_test_url = nil
      vim.cmd('edit ' .. vim.fn.fnameescape(filename))
      require('markdown-preview').open()
      return vim.api.nvim_get_current_buf()
    `, [filename]) as number
    let url = ''
    const deadline = Date.now() + 15000
    while (!url && Date.now() < deadline) {
      url = await nvim.lua('return vim.g.mkdp_test_url or ""') as string
      if (!url) await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.ok(url, `Neovim did not start the preview server: ${stderr}`)
    return { bufnr, url }
  }

  try {
    await nvim.lua(`
      local root, options = ...
      vim.opt.runtimepath:append(root)
      vim.opt.hidden = true
      vim.cmd('filetype on')
      vim.cmd('runtime plugin/markdown-preview.lua')
      options.browser = function(url) vim.g.mkdp_test_url = url end
      if options.auto_close == nil then options.auto_close = false end
      require('markdown-preview').setup(options)
    `, [repositoryRoot, options])
    return { nvim, ...await open(filename), open, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
