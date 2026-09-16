import { normalizeLanguage, plainCodeBlock, shouldHighlight } from './code-block'
import type { HighlightOptions, Highlighter, HighlightRequest, HighlightResponse } from './types'

const MAX_CACHE_ENTRIES = 512
const MAX_CACHE_BYTES = 8 * 1024 * 1024
let nextRequestId = 0

type WorkerHandle = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>
type OnHighlight = (id: number, html: string, source: string) => void

interface PendingHighlight extends HighlightRequest {
  key: string
}

export class HighlightClient implements Highlighter {
  private readonly cache = new Map<string, string>()
  private cacheBytes = 0
  private readonly pending = new Map<string, PendingHighlight>()
  private readonly queue = new Map<number, PendingHighlight>()
  private worker: WorkerHandle | null = null
  private active: PendingHighlight | null = null
  private failed = false
  private paused = false

  constructor(
    private readonly options: HighlightOptions,
    private readonly onHighlight: OnHighlight,
    private readonly createWorker: () => WorkerHandle = () =>
      new Worker(new URL('./highlight-worker.ts', import.meta.url), { type: 'module' })
  ) {}

  highlight(source: string, language: string) {
    language = normalizeLanguage(language)
    if (!shouldHighlight(source, language) || this.failed) {
      return plainCodeBlock(source, language)
    }
    const key = `${language}\0${source}`
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    let request = this.pending.get(key)
    if (!request) {
      request = { id: ++nextRequestId, key, source, language }
      this.pending.set(key, request)
      this.queue.set(request.id, request)
      this.startNext()
    }
    return plainCodeBlock(source, language, this.failed ? undefined : request.id)
  }

  // Only the current DOM needs work. Cached results and an in-flight block can
  // still be reused if the user switches back to a previous document.
  retain(ids: Set<number>) {
    for (const [id, request] of this.queue) {
      if (!ids.has(id)) {
        this.queue.delete(id)
        this.pending.delete(request.key)
      }
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused
    if (!paused) this.startNext()
  }

  dispose() {
    if (this.worker) {
      this.worker.onmessage = null
      this.worker.onerror = null
      this.worker.terminate()
    }
    this.worker = null
    this.active = null
    this.queue.clear()
    this.pending.clear()
    this.cache.clear()
    this.cacheBytes = 0
    this.failed = true
  }

  private remember(key: string, html: string) {
    const bytes = (key.length + html.length) * 2
    if (bytes > MAX_CACHE_BYTES) return
    while (this.cache.size >= MAX_CACHE_ENTRIES || this.cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = this.cache.entries().next().value
      if (!oldest) break
      this.cache.delete(oldest[0])
      this.cacheBytes -= (oldest[0].length + oldest[1].length) * 2
    }
    this.cache.set(key, html)
    this.cacheBytes += bytes
  }

  private startNext() {
    if (this.active || this.failed || this.paused) return
    const request = this.queue.values().next().value
    if (!request) return
    this.queue.delete(request.id)
    this.active = request
    try {
      const isNewWorker = !this.worker
      if (!this.worker) {
        this.worker = this.createWorker()
        this.worker.onmessage = (event: MessageEvent<HighlightResponse>) => this.complete(event.data)
        this.worker.onerror = (event) => this.fail(event.message)
      }
      const message: HighlightRequest = {
        id: request.id,
        source: request.source,
        language: request.language
      }
      if (isNewWorker) message.options = this.options
      this.worker.postMessage(message)
    } catch (error) {
      this.fail(error)
    }
  }

  private complete(response: HighlightResponse) {
    const request = this.active
    if (!request || response.id !== request.id) return
    if (response.error) console.error(`Code highlighting: ${response.error}`)
    // Failed loads may be retried on a later edit. Unknown languages are an
    // ordinary successful plain-text result and can be cached.
    if (!response.error) this.remember(request.key, response.html)
    this.active = null
    this.pending.delete(request.key)
    this.onHighlight(request.id, response.html, request.source)
    this.startNext()
  }

  private fail(error: unknown) {
    console.error('Code highlighting worker failed:', error)
    const pending = [...this.pending.values()]
    this.dispose()
    for (const request of pending) {
      this.onHighlight(request.id, plainCodeBlock(request.source, request.language), request.source)
    }
  }
}
