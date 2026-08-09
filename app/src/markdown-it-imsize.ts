import type MarkdownIt from 'markdown-it'
import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs'

interface ImageSize {
  ok: boolean
  pos: number
  width: string
  height: string
}

interface ParsedNumber {
  ok: boolean
  pos: number
  value: string
}

const emptySize = (pos: number): ImageSize => ({
  ok: false,
  pos,
  width: '',
  height: ''
})

function parseNextNumber(str: string, pos: number, max: number): ParsedNumber {
  const start = pos
  let code = str.charCodeAt(pos)

  while (pos < max && ((code >= 0x30 && code <= 0x39) || code === 0x25)) {
    pos += 1
    code = str.charCodeAt(pos)
  }

  return {
    ok: true,
    pos,
    value: str.slice(start, pos)
  }
}

function parseImageSize(str: string, pos: number, max: number): ImageSize {
  if (pos >= max || str.charCodeAt(pos) !== 0x3d) {
    return emptySize(pos)
  }

  pos += 1
  const code = str.charCodeAt(pos)
  if (code !== 0x78 && (code < 0x30 || code > 0x39)) {
    return emptySize(pos)
  }

  const width = parseNextNumber(str, pos, max)
  pos = width.pos

  if (str.charCodeAt(pos) !== 0x78) {
    return emptySize(pos)
  }

  const height = parseNextNumber(str, pos + 1, max)

  return {
    ok: true,
    pos: height.pos,
    width: width.value,
    height: height.value
  }
}

function imageWithSize(md: MarkdownIt): RuleInline {
  return (state, silent) => {
    const oldPos = state.pos
    const max = state.posMax

    if (state.src.charCodeAt(state.pos) !== 0x21 || state.src.charCodeAt(state.pos + 1) !== 0x5b) {
      return false
    }

    const labelStart = state.pos + 2
    const labelEnd = md.helpers.parseLinkLabel(state, state.pos + 1, false)
    if (labelEnd < 0) {
      return false
    }

    let pos = labelEnd + 1
    let href = ''
    let title = ''

    if (pos < max && state.src.charCodeAt(pos) === 0x28) {
      pos += 1
      while (pos < max) {
        const code = state.src.charCodeAt(pos)
        if (code !== 0x20 && code !== 0x0a) {
          break
        }
        pos += 1
      }
      if (pos >= max) {
        return false
      }

      let parsed = md.helpers.parseLinkDestination(state.src, pos, state.posMax)
      if (parsed.ok) {
        href = state.md.normalizeLink(parsed.str)
        if (state.md.validateLink(href)) {
          pos = parsed.pos
        } else {
          href = ''
        }
      }

      const titleStart = pos
      while (pos < max) {
        const code = state.src.charCodeAt(pos)
        if (code !== 0x20 && code !== 0x0a) {
          break
        }
        pos += 1
      }

      parsed = md.helpers.parseLinkTitle(state.src, pos, state.posMax)
      if (pos < max && titleStart !== pos && parsed.ok) {
        title = parsed.str
        pos = parsed.pos
        while (pos < max) {
          const code = state.src.charCodeAt(pos)
          if (code !== 0x20 && code !== 0x0a) {
            break
          }
          pos += 1
        }
      } else {
        title = ''
      }

      const size = parseImageSize(state.src, pos, max)
      if (size.ok) {
        pos = size.pos
      }

      if (pos >= max || state.src.charCodeAt(pos) !== 0x29) {
        state.pos = oldPos
        return false
      }
      pos += 1

      if (!silent) {
        const content = state.src.slice(labelStart, labelEnd)
        const token = state.push('image', 'img', 0)
        token.attrs = [['src', href], ['alt', '']]
        token.children = []
        token.content = content
        token.markup = state.src.slice(oldPos, pos)
        token.info = ''

        if (title) {
          token.attrs.push(['title', title])
        }
        if (size.width) {
          token.attrs.push(['width', size.width])
        }
        if (size.height) {
          token.attrs.push(['height', size.height])
        }
      }

      state.pos = pos
      state.posMax = max
      return true
    }

    return false
  }
}

export default function markdownImSize(md: MarkdownIt) {
  md.inline.ruler.before('emphasis', 'image', imageWithSize(md))
}
