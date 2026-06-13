const { plantumlPlaceholder } = require('./plantuml-placeholder')

export default (md, opts = {}) => {
  const temp = md.renderer.rules.fence.bind(md.renderer.rules)
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
    return temp(tokens, idx, options, env, slf)
  }
}
