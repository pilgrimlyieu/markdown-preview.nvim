import type MarkdownIt from 'markdown-it'
import { plantumlPlaceholder, PlantumlOptions } from './plantuml-placeholder'
import { getFenceRenderer } from './markdown-it-utils'

export default (md: MarkdownIt, opts: PlantumlOptions = {}) => {
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    try {
      if (token.info && token.info.indexOf('plantuml') != -1 ) {
        const code = token.content.trim()
        return plantumlPlaceholder(code, opts)
      }
    } catch (e) {
      console.error(`Parse Diagram Error: `, e)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}
