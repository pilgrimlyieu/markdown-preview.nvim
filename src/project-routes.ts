import type { PreviewRequest } from './routes'
import type { ServerResponse } from 'http'
import path from 'path'

import { listProjectDirectory, openProjectResource, readProjectFile } from './project-files'
import { previewPayload } from './rpc'

const errorStatus = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code
  if (['EACCES', 'EPERM', 'ELOOP'].includes(code || '')) return 403
  if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code || '')) return 404
  if (['EINVAL', 'ERR_INVALID_ARG_VALUE', 'ENAMETOOLONG'].includes(code || '')) return 400
  if (code === 'EFBIG') return 413
  if (code === 'EBUSY') return 429
  return 500
}

function byteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size - 1 }
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start
    ? { start, end } : null
}

export default async function projectRoutes(req: PreviewRequest, res: ServerResponse, next: () => void) {
  const match = req.asPath.match(/^\/api\/(files|preview|source|resource)\/(\d+)$/)
  if (!match) return next()
  const [, kind, bufnr] = match
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.method !== 'GET' && !(kind === 'resource' && req.method === 'HEAD')) {
    res.statusCode = 405
    res.setHeader('Allow', kind === 'resource' ? 'GET, HEAD' : 'GET')
    res.end()
    return
  }
  const request = new AbortController()
  req.once('aborted', () => request.abort())
  res.once('close', () => { if (!res.writableEnded) request.abort() })
  const { signal } = request
  let resource: Awaited<ReturnType<typeof openProjectResource>> | undefined
  try {
    if (!Number.isSafeInteger(Number(bufnr)) || Number(bufnr) < 1) {
      throw Object.assign(new Error('Invalid source buffer.'), { code: 'EINVAL' })
    }
    const params = new URL(req.url || '', 'http://localhost').searchParams
    const filename = params.get('path') || ''
    let result: unknown
    if (kind === 'source') {
      const payload = await previewPayload(req.plugin.nvim, bufnr, true)
      if (!payload?.content) throw Object.assign(new Error('The source preview has ended.'), { code: 'ENOENT' })
      result = { path: null, payload }
    } else if (kind === 'files') {
      const offset = Number(params.get('offset') || 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Invalid directory page.'), { code: 'EINVAL' })
      result = await listProjectDirectory(req.plugin.nvim, bufnr, filename,
        { offset, hidden: params.get('hidden') === '1', fresh: params.get('fresh') === '1' }, signal)
    } else if (kind === 'preview') {
      result = await readProjectFile(req.plugin.nvim, bufnr, filename, signal)
    } else {
      resource = await openProjectResource(req.plugin.nvim, bufnr, filename, params.get('download') === '1', signal)
      signal.throwIfAborted()
      const basename = encodeURIComponent(path.basename(resource.filename)).replace(/['()*]/g,
        char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      res.setHeader('Content-Type', resource.contentType)
      res.setHeader('Content-Disposition', `${resource.attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${basename}`)
      res.setHeader('Accept-Ranges', 'bytes')
      const range = byteRange(req.headers.range, resource.stat.size)
      if (!range) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${resource.stat.size}`)
        res.end()
        return
      }
      if (req.headers.range) {
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${resource.stat.size}`)
      }
      res.setHeader('Content-Length', range.end - range.start + 1)
      if (req.method === 'HEAD' || resource.stat.size === 0) {
        res.end()
        return
      }
      // Bound the stream to the inspected size even if the file grows. Downloads
      // may be large, but never require loading their entire contents into memory.
      const stream = resource.file.createReadStream(range)
      resource = undefined
      stream.once('error', () => res.destroy())
      res.once('close', () => stream.destroy())
      stream.pipe(res)
      return
    }
    if (signal.aborted) return
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(result))
  } catch (error) {
    if (signal.aborted || res.destroyed) return
    if (res.headersSent) { res.destroy(); return }
    res.statusCode = errorStatus(error)
    res.removeHeader('Content-Disposition')
    res.removeHeader('Content-Length')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Cannot read this project file.' }))
  } finally {
    await resource?.file.close()
  }
}
