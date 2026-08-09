import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import { escape } from './utils'
import type { KatexRenderer } from './types'

interface MathOptions extends Record<string, unknown> {
  displayMode?: boolean
  throwOnError?: boolean
}

function isValidDelim(state: StateInline, pos: number) {
  const max = state.posMax
  const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1
  const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1

  let canOpen = true
  let canClose = true

  if (prevChar === 0x20 || prevChar === 0x09 || (nextChar >= 0x30 && nextChar <= 0x39)) {
    canClose = false
  }
  if (nextChar === 0x20 || nextChar === 0x09) {
    canOpen = false
  }

  return {
    canOpen,
    canClose
  }
}

function mathInline(state: StateInline, silent: boolean) {
  if (state.src[state.pos] !== '$') {
    return false
  }

  let result = isValidDelim(state, state.pos)
  if (!result.canOpen) {
    if (!silent) {
      state.pending += '$'
    }
    state.pos += 1
    return true
  }

  const start = state.pos + 1
  let match = start
  while ((match = state.src.indexOf('$', match)) !== -1) {
    let pos = match - 1
    while (state.src[pos] === '\\') {
      pos -= 1
    }
    if ((match - pos) % 2 === 1) {
      break
    }
    match += 1
  }

  if (match === -1) {
    if (!silent) {
      state.pending += '$'
    }
    state.pos = start
    return true
  }

  if (match - start === 0) {
    if (!silent) {
      state.pending += '$$'
    }
    state.pos = start + 1
    return true
  }

  result = isValidDelim(state, match)
  if (!result.canClose) {
    if (!silent) {
      state.pending += '$'
    }
    state.pos = start
    return true
  }

  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.markup = '$'
    token.content = state.src.slice(start, match)
  }

  state.pos = match + 1
  return true
}

function mathBlock(state: StateBlock, start: number, end: number, silent: boolean) {
  let firstLine: string
  let lastLine = ''
  let next: number
  let lastPos: number
  let found = false
  let pos = state.bMarks[start] + state.tShift[start]
  let max = state.eMarks[start]

  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') {
    return false
  }

  pos += 2
  firstLine = state.src.slice(pos, max)

  if (silent) {
    return true
  }
  if (firstLine.trim().slice(-2) === '$$') {
    firstLine = firstLine.trim().slice(0, -2)
    found = true
  }

  for (next = start; !found;) {
    next += 1
    if (next >= end) {
      break
    }

    pos = state.bMarks[next] + state.tShift[next]
    max = state.eMarks[next]

    if (pos < max && state.tShift[next] < state.blkIndent) {
      break
    }

    if (state.src.slice(pos, max).trim().slice(-2) === '$$') {
      lastPos = state.src.slice(0, max).lastIndexOf('$$')
      lastLine = state.src.slice(pos, lastPos)
      found = true
    }
  }

  state.line = next + 1

  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
    state.getLines(start + 1, next, state.tShift[start], true) +
    (lastLine && lastLine.trim() ? lastLine : '')
  token.map = [start, state.line]
  token.markup = '$$'
  return true
}

function renderLatex(katexRenderer: KatexRenderer | null, latex: string, options: MathOptions) {
  if (!katexRenderer) {
    return escape(latex)
  }
  try {
    return katexRenderer.renderToString(latex, options)
  } catch (error) {
    if (options.throwOnError) {
      console.log(error)
    }
    return escape(latex)
  }
}

export default function mathPlugin(md: MarkdownIt, options: MathOptions = {}, katexRenderer: KatexRenderer | null = null) {
  const baseOptions: MathOptions = {
    ...options,
    macros: options.macros || {}
  }

  md.inline.ruler.after('escape', 'math_inline', mathInline)
  md.block.ruler.after('blockquote', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
  md.renderer.rules.math_inline = (tokens, idx) => {
    const renderOptions = {
      ...baseOptions,
      displayMode: baseOptions.displayMode ?? false
    }
    return renderLatex(katexRenderer, tokens[idx].content, renderOptions)
  }
  md.renderer.rules.math_block = (tokens, idx) => {
    const renderOptions = {
      ...baseOptions,
      displayMode: baseOptions.displayMode ?? true
    }
    return `<p>${renderLatex(katexRenderer, tokens[idx].content, renderOptions)}</p>\n`
  }
}
