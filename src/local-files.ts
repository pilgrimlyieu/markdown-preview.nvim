import fs from 'fs/promises'
import path from 'path'
import { execFileSync } from 'child_process'
import type { NeovimClient } from '@chemzqm/neovim'

import type { BufferId } from './app-contract'
import { asString } from './config'
import { previewDocument } from './rpc'

interface LocalFileOptions {
  document?: string | null
  imagesPath?: string
}

export function nativeEditorPath(filename: string) {
  return process.env.MINGW_HOME && !filename.includes(':')
    ? execFileSync('cygpath.exe', ['-w', '-a', filename], { encoding: 'utf8' }).replace(/\r?\n$/, '')
    : filename
}

async function exists(filename: string) {
  try {
    await fs.stat(filename)
    return true
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return false
    throw error
  }
}

export async function resolveLocalFile(
  nvim: NeovimClient,
  bufnr: BufferId,
  filename: string,
  options: LocalFileOptions = {}
) {
  if (!/^\d+$/.test(String(bufnr)) || Number(bufnr) < 1 || !filename || filename.includes('\0') || options.document?.includes('\0')) {
    throw Object.assign(new Error('Invalid local file link'), { code: 'EINVAL' })
  }
  const bufferPath = asString(await nvim.call('expand', `#${bufnr}:p`))
  if (!bufferPath && Number(await nvim.call('bufexists', Number(bufnr))) !== 1) {
    throw Object.assign(new Error('The source buffer no longer exists'), { code: 'ENOENT' })
  }
  const source = bufferPath ? path.resolve(nativeEditorPath(bufferPath)) : null
  const sourceDirectory = source ? path.dirname(source) : nativeEditorPath(asString(await nvim.call('getcwd')))
  const documentDirectory = options.document
    ? path.dirname(path.resolve(sourceDirectory, options.document))
    : sourceDirectory
  const directory = options.imagesPath ? path.resolve(nativeEditorPath(options.imagesPath)) : documentDirectory
  const exact = path.resolve(directory, filename)

  // Keep the image route's project-relative /assets/... convention for all
  // local links. Existing absolute files always win; drive/UNC paths stay exact.
  if (/^[/\\](?![/\\])/.test(filename) && !(await exists(exact))) {
    for (let dir = directory; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, filename)
      if (candidate !== exact && await exists(candidate)) return candidate
      if (path.dirname(dir) === dir) break
    }
  }
  return exact
}

export async function readLocalDocument(nvim: NeovimClient, bufnr: BufferId, filename: string) {
  const resolved = await resolveLocalFile(nvim, bufnr, filename)
  if (!/\.(?:md|markdown|mdown|mkd)$/i.test(resolved)) {
    throw Object.assign(new Error('This link is not a Markdown file'), { code: 'EINVAL' })
  }
  const document = await previewDocument(nvim, bufnr, resolved)
  if (!document.payload.content) {
    const source = await fs.readFile(resolved, 'utf8')
    document.payload.content = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  }
  return document
}
