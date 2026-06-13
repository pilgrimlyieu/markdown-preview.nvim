const chartPlugin = (md) => {
  const temp = md.renderer.rules.fence.bind(md.renderer.rules)
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
    return temp(tokens, idx, options, env, slf)
  }
}

export {
  chartPlugin
}

export default {
  chartPlugin
}
