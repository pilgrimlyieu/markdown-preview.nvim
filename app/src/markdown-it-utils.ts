import type MarkdownIt from 'markdown-it'
import type { RenderRule } from 'markdown-it/lib/renderer.mjs'

export function getFenceRenderer(md: MarkdownIt): RenderRule {
  const fence = md.renderer.rules.fence
  if (fence) {
    return fence.bind(md.renderer)
  }

  return (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options)
}
