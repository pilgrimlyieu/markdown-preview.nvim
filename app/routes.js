const fs = require('fs')
const path = require('path')
const logger = require('./lib/util/logger')('app/routes')

const routes = []

const CACHE_POLICIES = {
  immutable: 'public, max-age=31536000, immutable',
  revalidate: 'public, max-age=0, must-revalidate',
  noStore: 'no-store'
}

const mtimeSeconds = (stat) => Math.floor(stat.mtimeMs / 1000) * 1000

const weakEtag = (stat) => `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`

const isFresh = (req, stat, etag) => {
  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch && (ifNoneMatch === '*' || ifNoneMatch.split(/\s*,\s*/).includes(etag))) {
    return true
  }

  const ifModifiedSince = req.headers['if-modified-since']
  if (!ifNoneMatch && ifModifiedSince) {
    const modifiedSince = Date.parse(ifModifiedSince)
    return Number.isFinite(modifiedSince) && mtimeSeconds(stat) <= modifiedSince
  }

  return false
}

const sendFile = (req, res, fpath, cacheControl = CACHE_POLICIES.revalidate) => {
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

const use = function (route) {
  routes.unshift((req, res, next) => () => route(req, res, next))
}

// /page/:number
use((req, res, next) => {
  if (/\/page\/\d+/.test(req.asPath)) {
    return sendFile(req, res, './out/index.html', CACHE_POLICIES.noStore)
  }
  next()
})

// /_next/path
use((req, res, next) => {
  if (/\/_next/.test(req.asPath)) {
    const fpath = path.join('./out', req.asPath)
    if (fs.existsSync(fpath)) {
      return sendFile(req, res, fpath, CACHE_POLICIES.immutable)
    }
  }
  next()
})

// /_static/markdown.css
// /_static/highlight.css
use((req, res, next) => {
  try {
    if (req.mkcss && req.asPath === '/_static/markdown.css') {
      if (fs.existsSync(req.mkcss)) {
        return sendFile(req, res, req.mkcss)
      }
    } else if (req.hicss && req.asPath === '/_static/highlight.css') {
      if (fs.existsSync(req.hicss)) {
        return sendFile(req, res, req.hicss)
      }
    }
  } catch (e) {
    logger.error('load diy css fail: ', req.asPath, req.mkcss, req.hicss)
  }
  next()
})

// /_static/path
use((req, res, next) => {
  if (/\/_static/.test(req.asPath)) {
    const fpath = path.join('./', req.asPath)
    if (fs.existsSync(fpath)) {
      return sendFile(req, res, fpath)
    } else {
      logger.error('No such file:', req.asPath, req.mkcss, req.hicss)
    }
  }
  next()
})

// images
use(async (req, res, next) => {
  logger.info('image route: ', req.asPath)
  const reg = /^\/_local_image_/
  if (reg.test(req.asPath) && req.asPath !== '') {
    const plugin = req.plugin
    const buffers = await plugin.nvim.buffers
    const buffer = buffers.find(b => b.id === Number(req.bufnr))
    if (buffer) {
      let fileDir = ''
      if (req.custImgPath !== '' ){
        fileDir = req.custImgPath
      } else {
        fileDir = await plugin.nvim.call('expand', `#${req.bufnr}:p:h`)
      }

      logger.info('fileDir', fileDir)

      const  mingw_home=process.env.MINGW_HOME;
      if (mingw_home){
        if(! fileDir.includes(':')){
          // fileDir is unix-like:      /Z/x/y/...., 'Z' means Z:
          // the win-like fileDir should be: Z:\x\y...
          const cygpath = 'cygpath.exe'
          const cmd=cygpath+' -w'+' -a '+fileDir ;
          logger.info('cmd',cmd)
       
          const { execSync } = require('node:child_process');
          const result = execSync(cmd);
          fileDir=result.toString('utf8').replace('\n','');

          logger.info('New fileDir',fileDir);
        }  
      }

      let imgPath = decodeURIComponent(decodeURIComponent(req.asPath.replace(reg, '')))
      imgPath = imgPath.replace(/\\ /g, ' ')
      if (imgPath[0] !== '/' && imgPath[0] !== '\\') {
        imgPath = path.join(fileDir, imgPath)
      } else if (!fs.existsSync(imgPath)) {
        let tmpDirPath = fileDir
        while (tmpDirPath !== '/' && tmpDirPath !== '\\') {
          tmpDirPath = path.normalize(path.join(tmpDirPath, '..'))
          let tmpImgPath = path.join(tmpDirPath, imgPath)
          if (fs.existsSync(tmpImgPath)) {
            imgPath = tmpImgPath
            break
          }
        }
      }
      logger.info('imgPath', imgPath);
      
      if (fs.existsSync(imgPath) && !fs.statSync(imgPath).isDirectory()) {
        if (imgPath.endsWith('svg')) {
          res.setHeader('content-type', 'image/svg+xml')
        }
        return sendFile(req, res, imgPath)
      }
      logger.error('image not exists: ', imgPath)
    }
  }
  next()
})

// 404
use((req, res) => {
  res.statusCode = 404
  return sendFile(req, res, path.join('./out', '404.html'), CACHE_POLICIES.noStore)
})

module.exports = function (req, res, next) {
  return routes.reduce((next, route) => route(req, res, next), next)()
}
