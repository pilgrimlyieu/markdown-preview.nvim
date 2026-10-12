import { constants, type Dirent, type Stats } from 'fs'
import fs, { type FileHandle } from 'fs/promises'
import path from 'path'
import type { NeovimClient } from '@chemzqm/neovim'

import type { BufferId, PreviewPayload } from './app-contract'
import type { DirectoryEntry, DirectoryPage, FilePresentation, ProjectPreview } from './project-contract'
import { nativeEditorPath } from './local-files'
import { projectContext, projectDocument } from './rpc'

const PAGE_SIZE = 200
const DEFAULT_EXCLUDE = ['.git', '.jj', 'node_modules', '.venv', 'target', 'dist', 'build']
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon'
}
const ATTACHMENTS = new Set(['.pdf', '.zip', '.gz', '.xz', '.bz2', '.7z', '.tar', '.exe', '.dll', '.so',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.epub', '.woff', '.woff2', '.ttf', '.otf', '.wasm',
  '.mp3', '.mp4', '.webm', '.ogg', '.flac', '.wav', '.mov'])
const LANGUAGES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python', lua: 'lua', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cc: 'cpp', cs: 'csharp', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish', ps1: 'powershell', vim: 'viml',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', xml: 'xml',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', nix: 'nix', typ: 'typst', tex: 'latex',
  diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'make', cmake: 'cmake'
}

const failure = (message: string, code: string) => Object.assign(new Error(message), { code })
const limit = (value: number | undefined, fallback: number, ceiling: number) =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, ceiling) : fallback
const inside = (root: string, filename: string) => {
  const relative = path.relative(root, filename)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// One budget for all tabs in this server. Cancelled queued requests never start I/O.
let busy = 0
const waiting: Array<() => void> = []
async function filesystemWork<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const release = await new Promise<() => void>((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(start)
      if (index >= 0) waiting.splice(index, 1)
      reject(signal.reason)
    }
    const start = () => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) return reject(signal.reason)
      busy++
      resolve(() => {
        busy--
        waiting.shift()?.()
      })
    }
    if (busy < 4) start()
    else if (waiting.length >= 32) reject(failure('Too many file requests. Try again shortly.', 'EBUSY'))
    else {
      waiting.push(start)
      signal.addEventListener('abort', abort, { once: true })
    }
  })
  try {
    signal.throwIfAborted()
    return await work()
  } finally {
    release()
  }
}

async function context(nvim: NeovimClient, bufnr: BufferId, signal: AbortSignal) {
  if (!/^\d+$/.test(String(bufnr)) || !Number.isSafeInteger(Number(bufnr)) || Number(bufnr) < 1) {
    throw failure('Invalid source buffer.', 'EINVAL')
  }
  const value = await projectContext(nvim, bufnr)
  signal.throwIfAborted()
  if (!value?.root) throw failure('The source preview has ended.', 'ENOENT')
  const root = path.resolve(nativeEditorPath(value.root))
  const realRoot = await fs.realpath(root)
  const options = value.options || {}
  return {
    root, realRoot,
    exclude: new Set(Array.isArray(options.exclude) ? options.exclude.filter(name => typeof name === 'string') : DEFAULT_EXCLUDE),
    maxEntries: limit(options.max_entries, 20000, 1000000),
    maxText: limit(options.max_text_bytes, 2 * 1024 * 1024, 256 * 1024 * 1024),
    maxImage: limit(options.max_image_bytes, 20 * 1024 * 1024, 256 * 1024 * 1024)
  }
}
type Context = Awaited<ReturnType<typeof context>>

async function resolve(ctx: Context, filename: string, allowMissing = false) {
  if (filename.includes('\0')) throw failure('Invalid filename.', 'EINVAL')
  const literal = path.resolve(ctx.root, filename || '.')
  let real: string
  try {
    real = await fs.realpath(literal)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A named, loaded buffer can outlive its on-disk file. Its parent still has
    // to be inside the project; this is not permission to browse missing roots.
    real = path.join(await fs.realpath(path.dirname(literal)), path.basename(literal))
  }
  if (!inside(ctx.realRoot, real)) throw failure('This path is outside the preview project.', 'EACCES')
  return { literal, real }
}

interface Listing {
  entries: Dirent[]
  truncated: boolean
  signature: string
  expires: number
}
const listings = new Map<string, Listing>()
let cachedEntries = 0
function forget(key: string) {
  cachedEntries -= listings.get(key)?.entries.length || 0
  listings.delete(key)
}
function remember(key: string, listing: Listing) {
  forget(key)
  if (listing.entries.length > 20000) return
  while (listings.size >= 16 || cachedEntries + listing.entries.length > 20000) forget(listings.keys().next().value!)
  listings.set(key, listing)
  cachedEntries += listing.entries.length
}

export async function listProjectDirectory(
  nvim: NeovimClient, bufnr: BufferId, filename: string,
  options: { offset: number, hidden: boolean, fresh: boolean }, signal: AbortSignal
): Promise<DirectoryPage> {
  return filesystemWork(signal, async () => {
    const ctx = await context(nvim, bufnr, signal)
    const directory = await resolve(ctx, filename)
    const stat = await fs.stat(directory.real)
    if (!stat.isDirectory()) throw failure('This is not a directory.', 'ENOTDIR')
    const key = JSON.stringify([directory.real, [...ctx.exclude], options.hidden, ctx.maxEntries])
    const signature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`
    let listing = listings.get(key)
    if (options.fresh || !listing || listing.expires < Date.now() || listing.signature !== signature) {
      const entries: Dirent[] = []
      let examined = 0
      let truncated = false
      signal.throwIfAborted()
      const dir = await fs.opendir(directory.real)
      for await (const entry of dir) {
        signal.throwIfAborted()
        if (examined++ >= ctx.maxEntries) { truncated = true; break }
        if (ctx.exclude.has(entry.name) || (!options.hidden && entry.name.startsWith('.'))) continue
        entries.push(entry)
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      listing = { entries, truncated, signature, expires: Date.now() + 2000 }
      remember(key, listing)
    } else {
      // Access order, without extending the freshness window.
      forget(key)
      listings.set(key, listing)
      cachedEntries += listing.entries.length
    }
    signal.throwIfAborted()
    const offset = Math.min(options.offset, Math.max(0, Math.floor((listing.entries.length - 1) / PAGE_SIZE) * PAGE_SIZE))
    const page = listing.entries.slice(offset, offset + PAGE_SIZE)
    const entries = new Array<DirectoryEntry>(page.length)
    let next = 0
    const inspect = async () => {
      while (next < page.length) {
        signal.throwIfAborted()
        const index = next++
        const entry = page[index]
        const literal = path.join(directory.literal, entry.name)
        let type: DirectoryEntry['type'] = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unavailable'
        let reason: string | undefined
        if (entry.isSymbolicLink()) {
          try {
            const target = await resolve(ctx, literal)
            const stat = await fs.stat(target.real)
            type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unavailable'
          } catch {
            reason = 'Link is unavailable or outside the project.'
          }
        }
        entries[index] = { name: entry.name, path: literal, type,
          ...(entry.isSymbolicLink() ? { symlink: true } : {}),
          ...(type === 'unavailable' ? { reason: reason || 'Only directories and regular files can be opened.' } : {}) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, page.length) }, inspect))
    signal.throwIfAborted()
    return { root: ctx.root, path: directory.literal, entries, offset, limit: PAGE_SIZE,
      total: listing.entries.length, truncated: listing.truncated }
  })
}

async function regularFile(filename: string) {
  // Nonblocking opens avoid hanging on a FIFO substituted after the path check.
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
  const file = await fs.open(filename, flags)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw failure('Only regular files can be read.', 'EISDIR')
    return { file, stat }
  } catch (error) {
    await file.close()
    throw error
  }
}

async function boundedText(file: FileHandle, maxBytes: number, signal: AbortSignal) {
  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    signal.throwIfAborted()
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - bytes))
    const { bytesRead } = await file.read(chunk, 0, chunk.length, bytes)
    if (!bytesRead) break
    bytes += bytesRead
    if (bytes > maxBytes) return { tooLarge: bytes }
    chunks.push(chunk.subarray(0, bytesRead))
  }
  const buffer = Buffer.concat(chunks, bytes)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/.test(text)) return { binary: true, bytes }
    return { text, bytes }
  } catch {
    return { binary: true, bytes }
  }
}

const resourceUrl = (bufnr: BufferId, filename: string, download = false) =>
  `/api/resource/${bufnr}?${new URLSearchParams({ path: filename, ...(download ? { download: '1' } : {}) })}`
const language = (filename: string) => {
  for (const key of [path.extname(filename).slice(1).toLowerCase(), path.basename(filename).toLowerCase()]) {
    if (Object.hasOwn(LANGUAGES, key)) return LANGUAGES[key]
  }
  return 'text'
}

export async function readProjectFile(
  nvim: NeovimClient, bufnr: BufferId, filename: string, signal: AbortSignal
): Promise<ProjectPreview<PreviewPayload>> {
  return filesystemWork(signal, async () => {
    if (!filename) throw failure('Choose a file to preview.', 'EINVAL')
    const ctx = await context(nvim, bufnr, signal)
    const resolved = await resolve(ctx, filename, true)
    let stat: Stats | undefined
    try {
      stat = await fs.stat(resolved.real)
      if (!stat.isFile()) throw failure('Only regular files can be previewed.', 'EISDIR')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const extension = path.extname(resolved.literal).toLowerCase()
    const image = IMAGE_TYPES[extension]
    const text = !image && !ATTACHMENTS.has(extension)
    const document = await projectDocument(nvim, bufnr, resolved.literal, ctx.maxText, text)
    signal.throwIfAborted()
    if (document.source) return { kind: 'source', path: null }
    const payload = document.payload
    const downloadUrl = resourceUrl(bufnr, resolved.literal, true)
    const attachment = (message: string, size = stat?.size): ProjectPreview<PreviewPayload> => {
      const file: FilePresentation = { kind: 'attachment', message, downloadUrl, size,
        ...(extension === '.pdf' ? { openUrl: resourceUrl(bufnr, resolved.literal) } : {}) }
      return { kind: 'attachment', path: resolved.literal, payload: { ...payload, content: undefined, file } }
    }
    if (document.tooLarge !== undefined) return attachment('The loaded buffer exceeds the text preview limit.', document.tooLarge)
    if (image) {
      if (!stat) throw failure('This image no longer exists.', 'ENOENT')
      if (stat.size > ctx.maxImage) return attachment('This image exceeds the image preview limit.')
      return { kind: 'image', path: resolved.literal, payload: { ...payload,
        file: { kind: 'image', url: `${resourceUrl(bufnr, resolved.literal)}&v=${stat.mtimeMs}-${stat.size}`, downloadUrl, size: stat.size } } }
    }
    if (!text) {
      if (!stat) throw failure('This file no longer exists.', 'ENOENT')
      return attachment(extension === '.pdf' ? 'Open this PDF in your browser or download it.' : 'Download this file to open it in another application.')
    }
    let source: string
    let size: number
    if (payload.content) {
      source = payload.content.join('\n')
      size = Buffer.byteLength(source)
      if (size > ctx.maxText) return attachment('The loaded buffer exceeds the text preview limit.', size)
      if (/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/.test(source)) return attachment('This buffer contains binary data.', size)
    } else {
      if (stat && stat.size > ctx.maxText) return attachment('This file exceeds the text preview limit.')
      signal.throwIfAborted()
      const opened = await regularFile(resolved.real)
      try {
        if (opened.stat.size > ctx.maxText) return attachment('This file exceeds the text preview limit.', opened.stat.size)
        const result = await boundedText(opened.file, ctx.maxText, signal)
        if (result.tooLarge !== undefined) return attachment('This file exceeds the text preview limit.', result.tooLarge)
        if (result.text === undefined) return attachment('This file is binary or is not UTF-8 text.', result.bytes)
        source = result.text
        size = result.bytes!
      } finally {
        await opened.file.close()
      }
      payload.content = source.replace(/^\uFEFF/, '').split(/\r?\n/)
    }
    signal.throwIfAborted()
    if (/\.(?:md|markdown|mdown|mkd)$/i.test(extension)) return { kind: 'markdown', path: resolved.literal, payload }
    return { kind: 'text', path: resolved.literal, payload: { ...payload,
      file: { kind: 'text', language: language(resolved.literal), downloadUrl, size } } }
  })
}

/** The resource itself has the same root checks as its metadata. The caller owns the handle. */
export async function openProjectResource(
  nvim: NeovimClient, bufnr: BufferId, filename: string, download: boolean, signal: AbortSignal
) {
  return filesystemWork(signal, async () => {
    if (!filename) throw failure('Choose a file to download.', 'EINVAL')
    const ctx = await context(nvim, bufnr, signal)
    const resolved = await resolve(ctx, filename)
    signal.throwIfAborted()
    const opened = await regularFile(resolved.real)
    try {
      signal.throwIfAborted()
      const extension = path.extname(resolved.literal).toLowerCase()
      const image = IMAGE_TYPES[extension]
      if (!download && image && opened.stat.size > ctx.maxImage) throw failure('This image exceeds the image preview limit.', 'EFBIG')
      return { ...opened, filename: resolved.literal,
        contentType: image || (extension === '.pdf' ? 'application/pdf' : 'application/octet-stream'),
        attachment: download || (!image && extension !== '.pdf') }
    } catch (error) {
      await opened.file.close()
      throw error
    }
  })
}
