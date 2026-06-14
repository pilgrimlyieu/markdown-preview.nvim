import { execSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'

import { PreviewPlugin } from './app-contract'

const logger = require('./util/logger')('app/routes')

export interface PreviewRequest extends http.IncomingMessage {
  plugin: PreviewPlugin
  bufnr: string
  asPath: string
}

type Next = (() => void)
type Route = ((req: PreviewRequest, res: http.ServerResponse, next: Next) => unknown)

const routes: Route[] = []

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
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

const asString = (value: unknown) => typeof value === 'string' ? value : ''

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

const sendFile = (
  req: PreviewRequest,
  res: http.ServerResponse,
  fpath: string,
  cacheControl = CACHE_POLICIES.revalidate
) => {
  const contentType = contentTypeFor(fpath)
  if (contentType && !res.hasHeader('Content-Type')) {
    res.setHeader('Content-Type', contentType)
  }
  res.setHeader('Cache-Control', cacheControl)
  if (cacheControl === CACHE_POLICIES.noStore) {
    return fs.createReadStream(fpath).pipe(res)
  }

  const stat = fs.statSync(fpath)
  const etag = weakEtag(stat)

  res.setHeader('ETag', etag)
  res.setHeader('Last-Modified', stat.mtime.toUTCString())

  if (isFresh(req, stat, etag)) {
    res.statusCode = 304
    return res.end()
  }

  return fs.createReadStream(fpath).pipe(res)
}

const use = (route: Route) => {
  routes.push(route)
}

use((req, res, next) => {
  if (/\/page\/\d+/.test(req.asPath)) {
    return sendFile(req, res, './out/index.html', CACHE_POLICIES.noStore)
  }
  next()
})

use((req, res, next) => {
  if (/\/assets\//.test(req.asPath)) {
    const fpath = path.join('./out', req.asPath)
    if (fs.existsSync(fpath)) {
      return sendFile(req, res, fpath, isViteEntryAsset(req.asPath)
        ? CACHE_POLICIES.revalidate
        : CACHE_POLICIES.immutable)
    }
  }
  next()
})

use(async (req, res, next) => {
  try {
    if (req.asPath === '/_static/markdown.css') {
      const mkcss = asString(await req.plugin.nvim.getVar('mkdp_markdown_css'))
      if (mkcss && fs.existsSync(mkcss)) {
        return sendFile(req, res, mkcss)
      }
    } else if (req.asPath === '/_static/highlight.css') {
      const hicss = asString(await req.plugin.nvim.getVar('mkdp_highlight_css'))
      if (hicss && fs.existsSync(hicss)) {
        return sendFile(req, res, hicss)
      }
    }
  } catch (e) {
    logger.error('load diy css fail: ', req.asPath)
  }
  next()
})

use((req, res, next) => {
  if (/\/_static/.test(req.asPath)) {
    const fpath = path.join('./', req.asPath)
    if (fs.existsSync(fpath)) {
      return sendFile(req, res, fpath)
    }
    logger.error('No such file:', req.asPath)
  }
  next()
})

use(async (req, res, next) => {
  logger.debug('image route: ', req.asPath)
  const reg = /^\/_local_image_/
  if (reg.test(req.asPath) && req.asPath !== '') {
    const buffers = await req.plugin.nvim.buffers
    const buffer = buffers.find(candidate => candidate.id === Number(req.bufnr))
    if (buffer) {
      const customImagePath = asString(await req.plugin.nvim.getVar('mkdp_images_path'))
      let fileDir = customImagePath || asString(await req.plugin.nvim.call('expand', `#${req.bufnr}:p:h`))

      logger.debug('fileDir', fileDir)

      if (process.env.MINGW_HOME && !fileDir.includes(':')) {
        const cmd = `cygpath.exe -w -a ${fileDir}`
        logger.debug('cmd', cmd)
        fileDir = execSync(cmd).toString('utf8').replace('\n', '')
        logger.debug('New fileDir', fileDir)
      }

      let imgPath = decodeURIComponent(decodeURIComponent(req.asPath.replace(reg, '')))
      imgPath = imgPath.replace(/\\ /g, ' ')
      if (imgPath[0] !== '/' && imgPath[0] !== '\\') {
        imgPath = path.join(fileDir, imgPath)
      } else if (!fs.existsSync(imgPath)) {
        let tmpDirPath = fileDir
        while (tmpDirPath !== '/' && tmpDirPath !== '\\') {
          tmpDirPath = path.normalize(path.join(tmpDirPath, '..'))
          const tmpImgPath = path.join(tmpDirPath, imgPath)
          if (fs.existsSync(tmpImgPath)) {
            imgPath = tmpImgPath
            break
          }
        }
      }
      logger.debug('imgPath', imgPath)

      if (fs.existsSync(imgPath) && !fs.statSync(imgPath).isDirectory()) {
        return sendFile(req, res, imgPath)
      }
      logger.error('image not exists: ', imgPath)
    }
  }
  next()
})

use((req, res) => {
  res.statusCode = 404
  return sendFile(req, res, path.join('./out', '404.html'), CACHE_POLICIES.noStore)
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
