import type MarkdownIt from 'markdown-it'
import { getFenceRenderer } from './markdown-it-utils'

const chartPlugin = (md: MarkdownIt) => {
  const renderFence = getFenceRenderer(md)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    if (token.info && token.info.trim() === 'chart') {
      const code = token.content.trim()
      try {
        const json = JSON.parse(code)
        return `<canvas class="chartjs">${JSON.stringify(json)}</canvas>`
      } catch (e) { // JSON.parse exception
        return `<pre>${e}</pre>`
      }
    }
    return renderFence(tokens, idx, options, env, slf)
  }
}

export {
  chartPlugin
}

export default {
  chartPlugin
}
