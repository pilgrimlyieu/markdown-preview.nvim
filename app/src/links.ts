const markdownFile = /\.(?:md|markdown|mdown|mkd)$/i
const scheme = /^[a-z][a-z\d+.-]*:/i
const externalResource = (href: string) => href.startsWith('//') ||
  (scheme.test(href) && !/^[a-z]:[/\\]/i.test(href))

function localLink(href: string, documentPath: string | null) {
  if (!href || href.startsWith('#') || externalResource(href)) return null
  const match = href.match(/^([^?#]+)(\?[^#]*)?(#.*)?$/)
  if (!match) return null
  let filename = match[1]
  try { filename = decodeURIComponent(filename) } catch { /* A literal percent in an HTML link. */ }
  if (documentPath && !/^[/\\]|^[a-z]:[/\\]/i.test(filename)) {
    filename = documentPath.replace(/[^/\\]*$/, '') + filename
  }
  return { filename, search: match[2] || '', hash: match[3] || '' }
}

function openSeparately(link: Element) {
  if (!link.hasAttribute('target') && !link.hasAttribute('download')) link.setAttribute('target', '_blank')
  if (link.getAttribute('target') === '_blank') {
    const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean))
    rel.add('noopener')
    rel.add('noreferrer')
    link.setAttribute('rel', [...rel].join(' '))
  }
}

/** Keep real hrefs so copying links, middle clicks and modifier clicks work. */
export function prepareLinks(content: ParentNode, bufnr: number, documentPath: string | null) {
  for (const link of content.querySelectorAll<HTMLElement | SVGElement>('a')) {
    if (link.dataset.previewLinkReady) continue
    const href = link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    if (href === null) continue
    // Diagram renderers emit SVG xlink:href; the rest of navigation uses href.
    link.setAttribute('href', href)
    link.removeAttributeNS('http://www.w3.org/1999/xlink', 'href')
    link.dataset.previewLinkReady = 'true'
    if (/^(?:https?:|\/\/)/i.test(href)) {
      openSeparately(link)
      continue
    }
    const local = localLink(href, documentPath)
    if (!local) continue
    const markdown = markdownFile.test(local.filename) && !link.hasAttribute('download')
    const url = new URL(`/${markdown ? 'page' : 'file'}/${bufnr}`, window.location.href)
    url.searchParams.set('path', local.filename)
    link.setAttribute('href', url.pathname + url.search + local.hash)
    if (!markdown) openSeparately(link)
  }

  for (const img of content.querySelectorAll<HTMLImageElement>('img[src]')) {
    if (img.dataset.previewImageReady) continue
    img.dataset.previewImageReady = 'true'
    const src = img.getAttribute('src') || ''
    const local = localLink(src, null)
    if (!local) continue
    const url = new URL(`/_local_image_${encodeURIComponent(local.filename)}`, window.location.href)
    url.search = local.search
    // Shared previews can resolve the same relative name to different files.
    url.searchParams.set('bufnr', String(bufnr))
    if (documentPath) url.searchParams.set('document', documentPath)
    else url.searchParams.delete('document')
    img.setAttribute('src', url.pathname + url.search + local.hash)
  }
}
