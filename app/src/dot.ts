import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'
import { escape } from './utils'

const dot = (md: MarkdownIt) => {
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    try {
      if (token.info && (token.info.trim() === 'dot' || token.info.trim() === 'graphviz')) {
        const code = token.content.trim()
        return `<div class="dot">${escape(code)}</div>`
      }
    } catch (e) {
      console.error(`Parse dot Error: `, e)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export const renderDot = async () => {
  const list = document.querySelectorAll('.dot')
  if (!list.length) {
    return
  }

  // Graphviz is a megabyte of WebAssembly, so it only loads once a document
  // actually contains a dot block.
  const { instance } = await import('@viz-js/viz')
  const viz = await instance()

  list.forEach(item => {
    try {
      const element = viz.renderSVGElement(item.textContent || '')
      item.textContent = ''
      item.appendChild(element)
    } catch (e) {
      console.error(`Parse dot Error: ${e}`)
    }
  })
}

export default dot
