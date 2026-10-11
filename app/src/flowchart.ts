import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'
import { escape } from './utils'

let flowchartOptions: Record<string, unknown> = {}

const flowchart = (md: MarkdownIt, opts: Record<string, unknown> = {}) => {
  flowchartOptions = opts
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    try {
      if (token.info && token.info.trim() === 'flowchart') {
        const code = token.content.trim()
        return `<div class="flowchart">${escape(code)}</div>`
      }
    } catch (e) {
      console.error(`Parse flowchart Error: `, e)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export const renderFlowchart = (nodes: Iterable<HTMLElement>) => {
  if (!window.flowchart) {
    return
  }
  for (const item of nodes) {
    try {
      const d = window.flowchart!.parse(item.textContent)
      item.className = ''
      item.textContent = ''
      d.drawSVG(item, flowchartOptions)
    } catch (e) {
      console.error(`Parse flowchart Error: ${e}`)
    }
  }
}

export default flowchart
