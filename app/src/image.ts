import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

function resolveHtmlImage (tokens: Token[], idx: number) {
  let content = tokens[idx].content || ''

  content = content.replace(/<img\s+([^>]*?)src\s*=\s*(["'])(.*?)\2([^>]*)>/gm, (
    match: string,
    beforeSrc: string,
    _quote: string,
    src: string,
    afterSrc: string
  ) => {
    if (/^(http|\/\/|data:)/.test(src)) {
      return match
    }
    return `<img ${beforeSrc}src="/_local_image_${encodeURIComponent(src)}"${afterSrc}>`
  })

  return content
}

function resolveImage (tokens: Token[], idx: number) {
  const attrs = tokens[idx].attrs || []
  const src = attrs.find(([name]) => name === 'src')?.[1] || ''
  const alt = tokens[idx].content
  const resAttrs = attrs
    .filter(([name]) => name !== 'src' && name !== 'alt')
    .reduce((pre, cur) => `${pre} ${cur[0]}="${cur[1]}"`, '')
  if (/^(http|\/\/|data:)/.test(src)) {
    return `<img src="${src}" alt="${alt}" ${resAttrs} />`
  }
  return `<img src="/_local_image_${encodeURIComponent(src)}" alt="${alt}" ${resAttrs} />`
}

export default function localImage (md: MarkdownIt) {
  md.renderer.rules.image = resolveImage
  md.renderer.rules.html_block = resolveHtmlImage
  md.renderer.rules.html_inline = resolveHtmlImage
}
