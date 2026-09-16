import { createCodeHighlighter } from './highlight'
import { plainCodeBlock } from './code-block'
import type { HighlightRequest, HighlightResponse } from './types'

let highlighter: ReturnType<typeof createCodeHighlighter> | null = null

// The client keeps one request in flight. This also lets a new document drop
// obsolete queued blocks while this worker finishes its current block.
self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, source, language, options } = event.data
  let response: HighlightResponse
  try {
    highlighter ||= createCodeHighlighter(options)
    response = { id, html: await highlighter.highlight(source, language) }
  } catch (error) {
    response = {
      id,
      html: plainCodeBlock(source, language),
      error: error instanceof Error ? error.message : String(error)
    }
  }
  self.postMessage(response)
}
