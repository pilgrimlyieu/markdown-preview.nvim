import type MarkdownIt from 'markdown-it'
import getRender from 'md-it-meta/lib/meta'

type MarkdownItWithMeta = MarkdownIt & { meta: Record<string, unknown> }

export const meta = (separates?: string[][]) => {
  if (separates === void 0) {
    separates = [['---'], ['---']]
  }
  return (md: MarkdownIt) => {
    const markdownWithMeta = md as MarkdownItWithMeta
    markdownWithMeta.meta = markdownWithMeta.meta || {}
    const render = getRender(markdownWithMeta, separates as [string[], string[]])
    md.block.ruler.before(
      'code',
      'meta',
      (...args) => {
        try {
          return Boolean(render(...args))
        } catch(e) {
          console.log('md-it-meta', e)
          return false
        }
      },
      {
        alt: []
      }
    )
  }
}
