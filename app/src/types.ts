import type MarkdownIt from 'markdown-it'
import type { HLJSApi } from 'highlight.js'

export interface PreviewOptions {
  mkit?: Record<string, unknown>
  katex?: Record<string, unknown>
  uml?: Record<string, unknown>
  toc?: Record<string, unknown>
  maid?: Record<string, unknown>
  hide_yaml_meta?: number
  sequence_diagrams?: Record<string, unknown>
  flowchart_diagrams?: Record<string, unknown>
  content_editable?: boolean | number
  disable_filename?: boolean | number
  disable_sync_scroll?: boolean | number
  sync_scroll_type?: SyncScrollType
}
export interface PreviewPayload {
  options?: PreviewOptions
  isActive?: boolean
  winline?: number
  winheight?: number
  cursor?: number[]
  pageTitle?: string
  theme?: string
  name?: string
  content?: string[]
}

export interface ScrollPayload {
  options: PreviewOptions
  isActive: boolean
  winline: number
  winheight: number
  cursor: number[]
  len: number
}

export type SyncScrollType = 'relative' | 'middle' | 'top'

export interface ScrollRequest {
  cursor: number
  winline?: number
  winheight?: number
  len: number
}

export interface PreviewSocket {
  on: (event: string, handler: (data?: unknown) => void) => void
  close: () => void
}

export interface KatexRenderer {
  renderToString: (latex: string, options?: Record<string, unknown>) => string
}

export type Highlighter = Pick<HLJSApi, 'getLanguage' | 'highlight'>

export interface MarkdownRendererModule {
  createMarkdownRenderer: (
    options?: PreviewOptions,
    highlighter?: Highlighter | null,
    katexRenderer?: KatexRenderer | null
  ) => MarkdownIt
  renderDiagram: () => void
  renderFlowchart: () => void
  renderDot: () => void
}
