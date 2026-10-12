import fs from 'fs'
import http from 'http'
import path from 'path'

import { PreviewPlugin } from './app-contract'
import { asString, getConfig } from './config'
import { readLocalDocument, resolveLocalFile } from './local-files'
import createLogger from './util/logger'

const logger = createLogger('app/routes')

export interface PreviewRequest extends http.IncomingMessage {
  plugin: PreviewPlugin
  bufnr: string
  asPath: string
}

type Next = (() => void)
type Route = ((req: PreviewRequest, res: http.ServerResponse, next: Next) => unknown)

const routes: Route[] = []

// Everything is served out of `app/`, which is one level up from `app/lib/`.
// Resolving from __dirname keeps the server independent of its cwd.
const APP_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(APP_ROOT, 'out')

const CACHE_POLICIES = {
  immutable: 'public, max-age=31536000, immutable',
  revalidate: 'public, max-age=0, must-revalidate',
  noStore: 'no-store'
}

const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const mtimeSeconds = (stat: fs.Stats) => Math.floor(stat.mtimeMs / 1000) * 1000

const weakEtag = (stat: fs.Stats) => `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`

const contentTypeFor = (fpath: string) => CONTENT_TYPES[path.extname(fpath).toLowerCase()]

const isViteEntryAsset = (asPath: string) => /^\/assets\/index-[\w-]+\.(?:css|js)$/.test(asPath)

const isFresh = (req: PreviewRequest, stat: fs.Stats, etag: string) => {
  const ifNoneMatch = req.headers['if-none-match']
  if (typeof ifNoneMatch === 'string' && (ifNoneMatch === '*' || ifNoneMatch.split(/\s*,\s*/).includes(etag))) {
    return true
  }

  const ifModifiedSince = req.headers['if-modified-since']
  if (!ifNoneMatch && typeof ifModifiedSince === 'string') {
    const modifiedSince = Date.parse(ifModifiedSince)
    return Number.isFinite(modifiedSince) && mtimeSeconds(stat) <= modifiedSince
  }

  return false
}

const fileErrorStatus = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code || ''
  if (['EACCES', 'EPERM'].includes(code)) return 403
  if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code)) return 404
  if (['EINVAL', 'ERR_INVALID_ARG_VALUE'].includes(code)) return 400
  return 500
}

const sendFileError = (res: http.ServerResponse, error: unknown) => {
  if (res.destroyed) return
  if (res.headersSent) return res.destroy()
  res.statusCode = fileErrorStatus(error)
  res.removeHeader('Content-Disposition')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', CACHE_POLICIES.noStore)
  res.end(http.STATUS_CODES[res.statusCode])
}

const sendFile = async (
  req: PreviewRequest,
  res: http.ServerResponse,
  fpath: string,
  cacheControl = CACHE_POLICIES.revalidate
) => {
  let file: Awaited<ReturnType<typeof fs.promises.open>> | undefined
  try {
    file = await fs.promises.open(fpath, 'r')
    const stat = await file.stat()
    if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' })
    const contentType = contentTypeFor(fpath)
    if (contentType && !res.hasHeader('Content-Type')) res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', cacheControl)
    if (cacheControl !== CACHE_POLICIES.noStore) {
      const etag = weakEtag(stat)
      res.setHeader('ETag', etag)
      res.setHeader('Last-Modified', stat.mtime.toUTCString())
      if (isFresh(req, stat, etag)) {
        res.statusCode = 304
        res.end()
        return
      }
    }
    if (res.destroyed) return
    const stream = file.createReadStream()
    file = undefined // The stream now owns and closes the descriptor.
    stream.once('error', error => sendFileError(res, error))
    res.once('close', () => stream.destroy())
    stream.pipe(res)
  } catch (error) {
    sendFileError(res, error)
  } finally {
    await file?.close()
  }
}

const use = (route: Route) => {
  routes.push(route)
}

use((req, res, next) => {
  if (/^\/page\/\d+$/.test(req.asPath)) {
    return sendFile(req, res, path.join(OUT_DIR, 'index.html'), CACHE_POLICIES.noStore)
  }
  next()
})

use(async (req, res, next) => {
  const match = req.asPath.match(/^\/(api\/document|file)\/(\d+)$/)
  if (!match) return next()
  const [, kind, bufnr] = match
  const filename = new URL(req.url || '', 'http://localhost').searchParams.get('path') || ''
  res.setHeader('Cache-Control', CACHE_POLICIES.noStore)
  try {
    if (kind === 'api/document') {
      const document = await readLocalDocument(req.plugin.nvim, bufnr, filename)
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify(document))
    }
    const resolved = await resolveLocalFile(req.plugin.nvim, bufnr, filename)
    res.setHeader('Content-Type', contentTypeFor(resolved) || 'application/octet-stream')
    const basename = encodeURIComponent(path.basename(resolved)).replace(/['()*]/g,
      char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${basename}`)
    return sendFile(req, res, resolved, CACHE_POLICIES.noStore)
  } catch (error) {
    res.statusCode = fileErrorStatus(error)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return res.end(JSON.stringify({ error: `Cannot open local file: ${filename}` }))
  }
})

use((req, res, next) => {
  if (/\/assets\//.test(req.asPath)) {
    const fpath = path.join(OUT_DIR, req.asPath)
    if (fs.existsSync(fpath)) {
      return sendFile(req, res, fpath, isViteEntryAsset(req.asPath)
        ? CACHE_POLICIES.revalidate
        : CACHE_POLICIES.immutable)
    }
  }
  next()
})

// Only these two stylesheets are overridable, and asking the editor for the
// config costs an RPC round-trip, so never look it up for other assets.
const CSS_OVERRIDES: Record<string, 'markdown' | 'highlight'> = {
  '/_static/markdown.css': 'markdown',
  '/_static/highlight.css': 'highlight'
}

use(async (req, res, next) => {
  const override = CSS_OVERRIDES[req.asPath]
  if (override) {
    try {
      const { css = {} } = await getConfig(req.plugin.nvim)
      const custom = asString(css[override])
      if (custom && fs.existsSync(custom)) {
        return sendFile(req, res, custom)
      }
    } catch (e) {
      logger.error('load custom css failed: ', req.asPath)
    }
  }
  next()
})

use((req, res, next) => {
  if (/\/_static/.test(req.asPath)) {
    const fpath = path.join(APP_ROOT, req.asPath)
    if (fs.existsSync(fpath)) {
      return sendFile(req, res, fpath)
    }
    logger.error('No such file:', req.asPath)
  }
  next()
})

use(async (req, res, next) => {
  const prefix = '/_local_image_'
  if (!req.asPath.startsWith(prefix)) return next()
  try {
    // prepareLinks has separated the source URI into a filename and suffixes.
    const filename = decodeURIComponent(req.asPath.slice(prefix.length))
    const { images_path: imagesPath } = await getConfig(req.plugin.nvim)
    const params = new URL(req.url || '', 'http://localhost').searchParams
    const bufnr = params.get('bufnr')
    // Older pages omit the source buffer from the URL and depend on Referer.
    if (!bufnr) res.setHeader('Vary', 'Referer')
    const resolved = await resolveLocalFile(req.plugin.nvim, bufnr || req.bufnr, filename, {
      document: params.get('document'), imagesPath: asString(imagesPath)
    })
    return sendFile(req, res, resolved)
  } catch (error) {
    if (error instanceof URIError || [400, 404].includes(fileErrorStatus(error))) return next()
    return sendFileError(res, error)
  }
})

use((req, res) => {
  res.statusCode = 404
  return sendFile(req, res, path.join(OUT_DIR, '404.html'), CACHE_POLICIES.noStore)
})

export default function route(req: PreviewRequest, res: http.ServerResponse, fallback: Next = () => {}) {
  let index = 0
  const next = () => {
    const handler = routes[index]
    index += 1
    if (handler) {
      return handler(req, res, next)
    }
    return fallback()
  }
  return next()
}
