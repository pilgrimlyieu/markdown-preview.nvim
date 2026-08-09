import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'
import { escape } from './utils'

const mermaidChart = (code: string) => {
  return `<div class="mermaid">${escape(code)}</div>`
}

const MermaidPlugin = (md: MarkdownIt) => {
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    const code = token.content.trim()
    if (typeof token.info === 'string' && token.info.trim() === 'mermaid') {
      return mermaidChart(code)
    }
    const firstLine = code.split(/\n/)[0].trim()
    if (firstLine === 'gantt' ||
      firstLine === 'sequenceDiagram' ||
      firstLine === 'erDiagram' ||
      firstLine.match(/^graph (?:TB|BT|RL|LR|TD);?$/)) {
      return mermaidChart(code)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export default MermaidPlugin
