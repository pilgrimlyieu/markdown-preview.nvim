import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'
import { escape } from './utils'

let diagramOptions: Record<string, unknown> = {}

const diagram = (md: MarkdownIt, opts: Record<string, unknown> = {}) => {
  diagramOptions = opts
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    try {
      if (token.info && token.info.trim() === 'sequence-diagrams') {
        const code = token.content.trim()
        return `<div class="sequence-diagrams">${escape(code)}</div>`
      }
    } catch (e) {
      console.error(`Parse Diagram Error: `, e)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export const renderDiagram = (nodes: Iterable<HTMLElement>) => {
  if (!window.Diagram) {
    return
  }
  for (const item of nodes) {
    try {
      const d = window.Diagram!.parse(item.textContent)
      item.className = ''
      item.textContent = ''
      d.drawSVG(item, {
        theme: 'hand',
        ...diagramOptions
      })
    } catch (e) {
      console.error(`Parse Sequence-diagrams Error: ${e}`)
    }
  }
}

export default diagram
