import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { bundledLanguagesInfo } from 'shiki/langs'
import type { HighlighterCore, LanguageInput, LanguageRegistration } from 'shiki/types'

import { normalizeLanguage, plainCodeBlock, shouldHighlight } from './code-block'
import type { HighlightOptions } from './types'

// Preserve the names used by the previous highlighter, as well as terminal
// fences. Shiki's own aliases (js, ts, bash, vim, etc.) come from its registry.
const LEGACY_ALIASES: Record<string, string> = {
  assembly: 'asm',
  x86asm: 'asm',
  armasm: 'asm',
  mathematica: 'wolfram',
  pgsql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  terminal: 'ansi'
}

export interface CodeHighlighter {
  highlight: (source: string, language: string) => Promise<string>
  dispose: () => Promise<void>
}

export function createCodeHighlighter(options: HighlightOptions = {}): CodeHighlighter {
  const loaders = new Map<string, LanguageInput>()
  const customLanguages = new Map<string, LanguageRegistration>()
  const aliases = new Map<string, string>()
  const languageLoads = new Map<string, Promise<HighlighterCore>>()
  let corePromise: Promise<HighlighterCore> | null = null
  let disposed = false

  for (const language of bundledLanguagesInfo) {
    loaders.set(language.id, language.import)
    for (const alias of language.aliases || []) aliases.set(alias, language.id)
  }
  for (const [alias, language] of Object.entries(LEGACY_ALIASES)) aliases.set(alias, language)
  for (const language of options.languages || []) {
    const name = normalizeLanguage(language.name)
    customLanguages.set(name, { ...language, name })
    aliases.delete(name)
    for (const alias of language.aliases || []) {
      aliases.set(normalizeLanguage(alias), name)
    }
  }
  for (const [alias, language] of Object.entries(options.aliases || {})) {
    aliases.set(normalizeLanguage(alias), normalizeLanguage(language))
  }

  const resolveLanguage = (language: string) => {
    let name = normalizeLanguage(language)
    const visited = new Set<string>()
    while (aliases.has(name)) {
      if (aliases.get(name) === name) break
      if (visited.has(name)) return ''
      visited.add(name)
      name = aliases.get(name)!
    }
    return name
  }

  const languageInputs = (name: string): LanguageInput[] => {
    const names = new Set([name])
    const inputs: LanguageInput[] = []
    // Validate the entire dependency set before registering anything. Shiki
    // keeps failed registrations, which would break later unrelated loads.
    for (const dependency of names) {
      const custom = customLanguages.get(dependency)
      const loader = loaders.get(dependency)
      if (custom) {
        const { embeddedLanguages, ...grammar } = custom
        const embeddedLangs = (embeddedLanguages ?? grammar.embeddedLangs ?? []).map(resolveLanguage)
        inputs.push({ ...grammar, embeddedLangs })
        for (const embedded of embeddedLangs) names.add(embedded)
      } else if (loader) {
        inputs.push(loader)
      } else {
        throw new Error(`Unknown embedded language "${dependency}" required by "${name}"`)
      }
    }
    return inputs
  }

  const getCore = () => {
    if (!corePromise) {
      corePromise = createHighlighterCore({
        engine: createOnigurumaEngine(import('shiki/wasm')),
        langs: [],
        themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')]
      }).then((instance) => {
        if (disposed) {
          instance.dispose()
          throw new Error('Highlighter was disposed')
        }
        return instance
      }).catch((error) => {
        corePromise = null
        throw error
      })
    }
    return corePromise
  }

  const loadLanguage = (name: string): Promise<HighlighterCore> => {
    const cached = languageLoads.get(name)
    if (cached) return cached

    const inputs = name === 'ansi' ? [] : languageInputs(name)
    const load = getCore().then(async (instance) => {
      await instance.loadLanguage(...inputs)
      return instance
    }).catch((error) => {
      languageLoads.delete(name)
      throw error
    })
    languageLoads.set(name, load)
    return load
  }

  return {
    async highlight(source, language) {
      if (disposed) throw new Error('Highlighter was disposed')
      language = normalizeLanguage(language)
      const name = resolveLanguage(language)
      if (!shouldHighlight(source, language) ||
          (name !== 'ansi' && !customLanguages.has(name) && !loaders.has(name))) {
        return plainCodeBlock(source, language)
      }
      const core = await loadLanguage(name)
      return core.codeToHtml(source, {
        lang: name,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
        tokenizeMaxLineLength: 2000,
        tokenizeTimeLimit: 10,
        transformers: [{
          pre(node) {
            this.addClassToHast(node, 'hljs')
            // Keep the preview's code-block background. Only ANSI tokens need
            // theme background variables; inheriting them from <pre> would
            // paint a background on every ordinary token as well.
            node.properties.style = String(node.properties.style || '')
              .replace(/--shiki-(?:light|dark)-bg:[^;]+;?/g, '')
          },
          code(node) {
            this.addClassToHast(node, `language-${language}`)
          }
        }]
      })
    },
    async dispose() {
      disposed = true
      // A failed initialization has no instance to release.
      await corePromise?.then(instance => instance.dispose(), () => {})
    }
  }
}
