function scroll (offsetTop) {
  if (typeof window.scrollTo === 'function') {
    try {
      window.scrollTo({
        top: offsetTop,
        behavior: 'smooth'
      })
      return
    } catch (e) {
    }
  }

  const scrollingElement = document.scrollingElement || document.documentElement || document.body
  if (scrollingElement) {
    scrollingElement.scrollTop = offsetTop
  }
}

let sourceLineAnchors = null

function getDocumentOffsetTop (ele) {
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0
  return ele.getBoundingClientRect().top + scrollTop
}

function getSourceLineAnchors () {
  if (!sourceLineAnchors) {
    sourceLineAnchors = Array.prototype.slice.call(
      document.querySelectorAll('[data-source-line]')
    )
      .map((element) => ({
        element,
        line: Number(element.getAttribute('data-source-line'))
      }))
      .filter((anchor) => Number.isFinite(anchor.line))
      .sort((a, b) => a.line - b.line)
  }
  return sourceLineAnchors
}

function findSourceLineBounds (line) {
  const anchors = getSourceLineAnchors()
  let low = 0
  let high = anchors.length - 1
  let previous = null
  let next = null

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const anchor = anchors[mid]
    if (anchor.line === line) {
      return {
        previous: anchor,
        next: anchor
      }
    }
    if (anchor.line < line) {
      previous = anchor
      low = mid + 1
    } else {
      next = anchor
      high = mid - 1
    }
  }

  return {
    previous,
    next
  }
}

function clampLine (line, len) {
  return Math.max(0, Math.min(line, len - 1))
}

function isDocumentEdge (line, len) {
  return line === 0 || line === len - 1
}

function scrollDocumentEdge (line) {
  scroll(line === 0 ? 0 : document.documentElement.scrollHeight)
}

function getLineOffsetTop (line, len) {
  const bounds = findSourceLineBounds(line)
  if (bounds.previous && bounds.previous === bounds.next) {
    return getDocumentOffsetTop(bounds.previous.element)
  }

  const previousLine = bounds.previous ? bounds.previous.line : 0
  const previousTop = bounds.previous ? getDocumentOffsetTop(bounds.previous.element) : 0
  const nextLine = bounds.next ? bounds.next.line : len - 1
  const nextTop = bounds.next ? getDocumentOffsetTop(bounds.next.element) : document.documentElement.scrollHeight
  const distance = nextLine - previousLine

  return distance > 0
    ? previousTop + ((nextTop - previousTop) * (line - previousLine) / distance)
    : previousTop
}

function scrollRelativeLine (line, ratio, len) {
  const offsetTop = getLineOffsetTop(line, len)
  scroll(offsetTop - document.documentElement.clientHeight * ratio)
}

function scrollLine (line, ratio, len) {
  const clampedLine = clampLine(line, len)
  if (isDocumentEdge(clampedLine, len)) {
    scrollDocumentEdge(clampedLine)
  } else {
    scrollRelativeLine(clampedLine, ratio, len)
  }
}

const scrollToLine = {
  relative: function ({
    cursor,
    winline,
    winheight,
    len
  }) {
    const line = cursor - 1
    const ratio = winline / winheight
    scrollLine(line, ratio, len)
  },
  middle: function ({
    cursor,
    // winline,
    // winheight,
    len
  }) {
    const line = cursor - 1
    scrollLine(line, 0.5, len)
  },
  top: function ({
    cursor,
    winline,
    // winheight,
    len
  }) {
    const line = cursor - 1
    if (isDocumentEdge(line, len)) {
      scrollDocumentEdge(line)
    } else {
      scrollLine(cursor - winline, 0, len)
    }
  },
  invalidate: function () {
    sourceLineAnchors = null
  }
}

export default scrollToLine
