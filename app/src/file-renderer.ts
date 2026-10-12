import type { Highlighter, PreviewPayload } from './types'
import { escape } from './utils'

let nextImage = 0

/** Prepare one real image node before navigation commits. Moving this node into
 * the page avoids a second request between validation and display. */
export async function loadFileImage(url: string, name: string, signal: AbortSignal): Promise<HTMLImageElement> {
  signal.throwIfAborted()
  if (document.hidden) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        document.removeEventListener('visibilitychange', visible)
        signal.removeEventListener('abort', abort)
      }
      const visible = () => { if (!document.hidden) { cleanup(); resolve() } }
      const abort = () => { cleanup(); reject(signal.reason) }
      document.addEventListener('visibilitychange', visible)
      signal.addEventListener('abort', abort, { once: true })
      visible()
    })
  }
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.className = 'file-image'
    img.dataset.previewImageReady = 'true'
    img.alt = name || 'Selected image'
    img.decoding = 'async'
    const cleanup = () => {
      img.onload = img.onerror = null
      signal.removeEventListener('abort', abort)
    }
    const abort = () => { cleanup(); img.removeAttribute('src'); reject(signal.reason) }
    img.onload = () => { cleanup(); resolve(img) }
    img.onerror = () => { cleanup(); reject(new Error(`Cannot load image: ${name}`)) }
    signal.addEventListener('abort', abort, { once: true })
    const fresh = new URL(url, window.location.href)
    // A live img can retain a decoded resource even when HTTP uses no-store.
    fresh.searchParams.set('preview', `${Date.now()}-${++nextImage}`)
    img.src = fresh.href
  })
}

function link(href: string, label: string, download = false) {
  // These are already service URLs, not Markdown-relative filenames. Both the
  // detached render pass and the live SVG/link observer must leave them alone.
  return `<a data-preview-link-ready="true" href="${escape(href)}"${download ? ' download' : ''} target="_blank" rel="noopener noreferrer">${label}</a>`
}

function sizeLabel(bytes: number | undefined) {
  if (bytes === undefined || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024 * 10) / 10} KiB`
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`
}

export function renderFile(payload: PreviewPayload, highlighter: Highlighter) {
  const file = payload.file!
  const download = link(file.downloadUrl, file.kind === 'text' ? 'Download saved file' : 'Download file', true)
  const actions = `<div class="file-actions" contenteditable="false"><span>${sizeLabel(file.size)}</span>${download}</div>`
  if (file.kind === 'text') {
    return `<div class="file-preview" data-file-kind="text">${actions}${highlighter.highlight((payload.content || []).join('\n'), file.language)}</div>`
  }
  if (file.kind === 'image') {
    return `<div class="file-preview" data-file-kind="image">${actions}<span class="file-image-slot"></span></div>`
  }
  return `<div class="file-preview file-attachment" data-file-kind="attachment"><p>${escape(file.message)}</p>${actions}${file.openUrl ? link(file.openUrl, 'Open in browser') : ''}</div>`
}
