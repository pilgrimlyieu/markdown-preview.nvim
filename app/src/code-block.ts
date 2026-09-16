import { escape } from './utils'

// Count UTF-16 code units, like string.length. Large logs and minified files
// should stay readable without spending seconds tokenizing one fence.
export const MAX_HIGHLIGHT_LENGTH = 64 * 1024

const PLAIN_LANGUAGES = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none', 'nohighlight', 'no-highlight'])

export const normalizeLanguage = (language: string) => language.trim().toLowerCase()

export const shouldHighlight = (source: string, normalizedLanguage: string) =>
  source.length > 0 && source.length <= MAX_HIGHLIGHT_LENGTH && !PLAIN_LANGUAGES.has(normalizedLanguage)

export function plainCodeBlock(source: string, language: string, pendingId?: number) {
  const languageClass = language ? ` class="language-${escape(language)}"` : ''
  const pending = pendingId === undefined ? '' : ` data-highlight-id="${pendingId}"`
  return `<pre class="hljs"${pending}><code${languageClass}>${escape(source)}</code></pre>`
}
