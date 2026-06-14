type MarkdownPlugin = (md: import('markdown-it').default, options?: unknown) => void

declare module 'markdown-it-emoji' {
  const plugin: MarkdownPlugin
  export default plugin
}

declare module 'markdown-it-task-lists' {
  const plugin: MarkdownPlugin
  export default plugin
}

declare module 'markdown-it-footnote' {
  const plugin: MarkdownPlugin
  export default plugin
}

declare module 'markdown-it-deflist' {
  const plugin: MarkdownPlugin
  export default plugin
}

declare module 'markdown-it-admon' {
  const plugin: MarkdownPlugin
  export default plugin
}

declare module 'md-it-meta/lib/meta' {
  const getRender: (md: MarkdownIt, separates: string[][]) => (...args: unknown[]) => boolean | undefined
  export default getRender
}

declare module 'katex/dist/contrib/mhchem.mjs' {
  const value: unknown
  export default value
}

declare module 'plantuml-encoder' {
  const encoder: {
    encode: (source: string) => string
  }
  export default encoder
}

declare const Viz: new () => {
  renderSVGElement: (source: string | null) => Promise<Node>
}

interface Window {
  Viz?: typeof Viz
  Diagram?: {
    parse: (source: string | null) => {
      drawSVG: (element: Element, options: Record<string, unknown>) => void
    }
  }
  flowchart?: {
    parse: (source: string | null) => {
      drawSVG: (element: Element, options: Record<string, unknown>) => void
    }
  }
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}
