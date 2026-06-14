import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'

const dot = (md: MarkdownIt) => {
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    try {
      if (token.info && (token.info.trim() === 'dot' || token.info.trim() === 'graphviz')) {
        const code = token.content.trim()
        return `<div class="dot">${code}</div>`
      }
    } catch (e) {
      console.error(`Parse dot Error: `, e)
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export const renderDot = () => {
  const list = document.querySelectorAll('.dot')
  if (typeof Viz === 'undefined' || !list.length) {
    return
  }
  const viz = new Viz()
  list.forEach(item => {
    viz.renderSVGElement(item.textContent)
      .then((element) => {
        item.textContent = ''
        item.appendChild(element)
      })
      .catch(e => {
        console.error(`Parse dot Error: ${e}`)
      })
  })
}

export default dot
