import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'

let diagramOptions: Record<string, unknown> = {}

const diagram = (md: MarkdownIt, opts: Record<string, unknown> = {}) => {
  diagramOptions = opts
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    try {
      if (token.info && token.info.trim() === 'sequence-diagrams') {
        const code = token.content.trim()
        return `<div class="sequence-diagrams">${code}</div>`
      }
    } catch (e) {
      console.error(`Parse Diagram Error: `, e)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export const renderDiagram = () => {
  const list = document.querySelectorAll('.sequence-diagrams')
  if (!window.Diagram || !list.length) {
    return
  }
  list.forEach(item => {
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
  })
}

export default diagram
