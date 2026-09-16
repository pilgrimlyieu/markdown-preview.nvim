import assert from 'node:assert/strict'
import { createCodeHighlighter } from '../app/src/highlight'
import { HighlightClient } from '../app/src/highlight-client'
import { MAX_HIGHLIGHT_LENGTH, plainCodeBlock } from '../app/src/code-block'
import { createMarkdownRenderer } from '../app/src/markdown-renderer'
import type { HighlightRequest, HighlightResponse } from '../app/src/types'

const fence = (language: string, source: string) => `\`\`\`${language}\n${source}\n\`\`\`\n`

async function assertLanguagesAndAnsi() {
  const highlighter = createCodeHighlighter()
  const samples = [
    ['lua', 'local answer = 42'],
    ['LUA', 'local answer = 42'],
    ['rust', 'fn main() { println!("hello"); }'],
    ['go', 'package main\nfunc main() {}'],
    ['python', 'def answer():\n    return 42'],
    ['js', 'const answer = 42;'],
    ['ts', 'const answer: number = 42;'],
    ['tsx', 'const view = <div>hello</div>;'],
    ['c', 'int main(void) { return 0; }'],
    ['cpp', 'int main() { return 0; }'],
    ['csharp', 'public class Test { int answer = 42; }'],
    ['java', 'public class Test {}'],
    ['kotlin', 'fun main() { println("hello") }'],
    ['swift', 'let answer = 42'],
    ['bash', 'echo "hello"'],
    ['powershell', 'Write-Host "hello"'],
    ['vim', 'let g:answer = 42'],
    ['toml', '[settings]\nanswer = 42'],
    ['yaml', 'answer: 42'],
    ['json', '{"answer": 42}'],
    ['dockerfile', 'FROM alpine:3.20'],
    ['nix', '{ pkgs }: pkgs.hello'],
    ['typst', '#let answer = 42'],
    ['vue', '<template><div>{{ value }}</div></template>'],
    ['mips', 'addi $t0, $zero, 42'],
    ['assembly', 'mov eax, 42'],
    ['mathematica', 'Sin[x]^2'],
    ['pgsql', 'SELECT count(*) FROM users;'],
    ['ansi', '\u001b[31mred\u001b[0m'],
    ['terminal', '\u001b[31mred\u001b[0m']
  ]
  try {
    for (const [language, source] of samples) {
      const html = await highlighter.highlight(source, language)
      assert.match(html, /<span\b/, `${language} should produce highlighted text`)
      assert.match(html, /--shiki-light:/)
      assert.match(html, /--shiki-dark:/)
      assert.match(html, new RegExp(`class="language-${language.toLowerCase()}"`))
    }
    const ansi = await highlighter.highlight([
      '\u001b[31mred\u001b[0mnormal',
      '\u001b[38;5;196mindexed\u001b[0m',
      '\u001b[38;2;1;2;3mtruecolor\u001b[0m',
      '\u001b[48;2;4;5;6mbackground\u001b[0m',
      '\u001b[1;3;4;9mbold italic underline strike\u001b[0m',
      '\u001b[7mreverse\u001b[0m',
      '\u001b[2mdim\u001b[0m',
      '\u001b[31m<img src=x onerror=alert(1)>\u001b[0m'
    ].join('\n'), 'ansi')
    assert.doesNotMatch(ansi, /\u001b|<img\b|onerror="/)
    assert.match(ansi, /#ff0000/i)
    assert.match(ansi, /#010203/i)
    assert.match(ansi, /#040506/i)
    assert.match(ansi, /font-weight:bold/)
    assert.match(ansi, /font-style:italic/)
    assert.match(ansi, /underline/)
    assert.match(ansi, /line-through/)
    assert.match(ansi, /80(?:;|")/)
    const reset = await highlighter.highlight('\u001b[31mred\u001b[0mnormal', 'ansi')
    assert.match(reset, /#24292e[^>]*>normal</i)
    await highlighter.highlight('\u001b[31munterminated red', 'ansi')
    assert.doesNotMatch(await highlighter.highlight('another block', 'ansi'), /#d73a49/i,
      'ANSI state must not leak across fences')

    for (const language of ['text', '', 'nohighlight', 'unknown-language', 'constructor', '__proto__']) {
      const html = await highlighter.highlight('<script>alert("x")</script>&', language)
      assert.doesNotMatch(html, /<script|<span\b|data-highlight-id/)
      assert.match(html, /&lt;script&gt;/)
    }
    const huge = await highlighter.highlight('x'.repeat(MAX_HIGHLIGHT_LENGTH + 1), 'lua')
    assert.doesNotMatch(huge, /<span\b|data-highlight-id/)
    const longLine = await highlighter.highlight('local value = '.repeat(300), 'lua')
    assert.doesNotMatch(longLine, /<span style=/, 'minified lines should skip tokenization')
    const html = await highlighter.highlight('<script>alert("x")</script>', 'html')
    assert.match(html, /&#x3C;|&lt;/)
    assert.doesNotMatch(html, /<script>/)
  } finally {
    await highlighter.dispose()
  }
}

async function assertCustomLanguages() {
  const highlighter = createCodeHighlighter({
    languages: [
      {
        name: 'tiny-script',
        scopeName: 'source.tiny-script',
        aliases: ['tiny'],
        repository: {},
        patterns: [{ match: '\\b(?:HELLO|END)\\b', name: 'keyword.control.tiny-script' }]
      },
      {
        name: 'embedded-example',
        scopeName: 'source.embedded-example',
        embeddedLangs: ['js', 'tiny'],
        repository: {},
        patterns: [
          { begin: '<js>', end: '</js>', patterns: [{ include: 'source.js' }] },
          { begin: '<tiny>', end: '</tiny>', patterns: [{ include: 'source.tiny-script' }] }
        ]
      },
      {
        name: 'broken-dependency',
        scopeName: 'source.broken-dependency',
        embeddedLangs: ['not-an-installed-language'],
        repository: {},
        patterns: []
      },
      {
        name: 'legacy-embedded-example',
        scopeName: 'source.legacy-embedded-example',
        embeddedLanguages: ['js'],
        embeddedLangs: ['ignored-in-favor-of-embeddedLanguages'],
        repository: {},
        patterns: [{ include: 'source.js' }]
      },
      {
        name: 'broken-legacy-dependency',
        scopeName: 'source.broken-legacy-dependency',
        embeddedLanguages: ['not-an-installed-language'],
        repository: {},
        patterns: []
      }
    ],
    aliases: { demo: 'tiny', lua: 'lua', first: 'second', second: 'first' }
  })
  try {
    for (const language of ['tiny-script', 'tiny', 'demo']) {
      assert.match(await highlighter.highlight('HELLO friend END', language), /#d73a49[^>]*>HELLO/i)
    }
    const embedded = await highlighter.highlight('<js>\nconst answer = 42;\n</js>\n<tiny>HELLO</tiny>', 'embedded-example')
    assert.match(embedded, /#d73a49[^>]*>const</i, 'embedded built-in aliases should resolve before registration')
    assert.match(embedded, /#d73a49[^>]*>HELLO</i, 'embedded custom aliases should resolve before registration')
    assert.match(await highlighter.highlight('const legacy = 42;', 'legacy-embedded-example'), /#d73a49[^>]*>const</i,
      'embeddedLanguages must receive the same normalization and take precedence over embeddedLangs')
    await assert.rejects(highlighter.highlight('example', 'broken-dependency'), /Unknown embedded language/)
    await assert.rejects(highlighter.highlight('example', 'broken-legacy-dependency'), /Unknown embedded language/)
    assert.match(await highlighter.highlight('print("still works")', 'python'), /<span\b/,
      'invalid custom dependencies must not poison later language loads')
    assert.match(await highlighter.highlight('local answer = 42', 'lua'), /<span\b/)
    assert.doesNotMatch(await highlighter.highlight('<tag>', 'first'), /<span\b|<tag>/)
  } finally {
    await highlighter.dispose()
  }
}

function fakeWorker() {
  const messages: HighlightRequest[] = []
  const worker = {
    onmessage: null as ((event: MessageEvent<HighlightResponse>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: HighlightRequest) { messages.push(message) },
    terminate() {}
  }
  return {
    worker,
    messages,
    complete(html = '<pre class="shiki"><code>highlighted</code></pre>', error?: string) {
      const last = messages.at(-1)!
      worker.onmessage?.({ data: { id: last.id, html, error } } as MessageEvent<HighlightResponse>)
    }
  }
}

function assertClientCachingAndQueue() {
  const fake = fakeWorker()
  let workersCreated = 0
  const results: number[] = []
  const client = new HighlightClient({}, id => results.push(id), () => {
    workersCreated += 1
    return fake.worker
  })
  const md = createMarkdownRenderer({}, client)
  md.render(fence('', 'unlabelled') + fence('text', 'plain') + fence('lua', 'x'.repeat(MAX_HIGHLIGHT_LENGTH + 1)))
  assert.equal(workersCreated, 0, 'plain and oversized blocks must not start a worker')

  const source = fence('lua', 'local answer = 42')
  const first = md.render(source + source)
  assert.equal(fake.messages.length, 1, 'identical fences share an in-flight request')
  const id = fake.messages[0].id
  assert.equal(first.match(new RegExp(`data-highlight-id="${id}"`, 'g'))?.length, 2)
  fake.complete()
  assert.deepEqual(results, [id])
  assert.match(md.render('changed paragraph\n\n' + source), /class="shiki"/)
  assert.equal(fake.messages.length, 1, 'editing prose must reuse the code result')
  createMarkdownRenderer({ katex: { strict: false } }, client).render(source)
  assert.equal(fake.messages.length, 1, 'renderer recreation must preserve the cache')

  md.render(fence('lua', 'local active = 1') + fence('lua', 'local stale = 2'))
  assert.equal(fake.messages.length, 2, 'only one worker request is in flight')
  const current = md.render(fence('lua', 'local current = 3'))
  const currentId = Number(current.match(/data-highlight-id="(\d+)"/)?.[1])
  client.retain(new Set([currentId]))
  fake.complete()
  assert.equal(fake.messages.length, 3)
  assert.match(fake.messages.at(-1)!.source, /current/)
  fake.complete()
  assert.equal(workersCreated, 1)
  assert.equal(fake.messages.filter(message => message.options !== undefined).length, 1,
    'custom grammar configuration is only sent when starting the worker')
  client.dispose()
}

function assertClientCacheBounds() {
  const fake = fakeWorker()
  const client = new HighlightClient({}, () => {}, () => fake.worker)
  const original = 'local first = 42'
  client.highlight(original, 'lua')
  fake.complete()
  for (let i = 0; i < 600; i += 1) {
    client.highlight(`local value = ${i}`, 'lua')
    fake.complete()
  }
  const before = fake.messages.length
  client.highlight(original, 'lua')
  assert.equal(fake.messages.length, before + 1, 'old entries must be evicted instead of growing forever')
  fake.complete()
  // Output expansion also counts towards the byte budget, even with few keys.
  for (let i = 0; i < 20; i += 1) {
    client.highlight(`local large = ${i}`, 'lua')
    fake.complete('x'.repeat(300_000))
  }
  const afterLarge = fake.messages.length
  client.highlight(original, 'lua')
  assert.equal(fake.messages.length, afterLarge + 1, 'cache size must include generated HTML')
  client.dispose()
}

function assertClientPauseAndResume() {
  const fake = fakeWorker()
  const client = new HighlightClient({}, () => {}, () => fake.worker)
  client.highlight('active', 'lua')
  client.highlight('old queue', 'lua')
  client.setPaused(true)
  fake.complete()
  assert.equal(fake.messages.length, 1, 'pausing lets active work finish without dispatching the next block')
  client.retain(new Set())
  client.highlight('new document', 'lua')
  assert.equal(fake.messages.length, 1, 'new work waits while the preview is hidden')
  client.setPaused(false)
  assert.equal(fake.messages.length, 2)
  assert.equal(fake.messages.at(-1)!.source, 'new document', 'resuming must skip the discarded old queue')
  fake.complete()
  client.dispose()
}

function assertWorkerFailureFallback() {
  const errors: unknown[][] = []
  const savedError = console.error
  console.error = (...args) => { errors.push(args) }
  try {
    const client = new HighlightClient({}, () => {}, () => { throw new Error('Worker unavailable') })
    const html = client.highlight('<img src=x>', 'lua')
    assert.equal(html, plainCodeBlock('<img src=x>', 'lua'))
    assert.doesNotMatch(html, /data-highlight-id|<img\b/)
    assert.equal(errors.length, 1)
    client.dispose()

    const fake = fakeWorker()
    const retryClient = new HighlightClient({}, () => {}, () => fake.worker)
    retryClient.highlight('local value = 42', 'lua')
    fake.complete(plainCodeBlock('local value = 42', 'lua'), 'grammar chunk failed to load')
    retryClient.highlight('local value = 42', 'lua')
    assert.equal(fake.messages.length, 2, 'a failed language load should be retried after an edit')
    fake.complete()
    retryClient.highlight('local value = 42', 'lua')
    assert.equal(fake.messages.length, 2, 'a successful retry should then be cached')
    retryClient.dispose()
  } finally {
    console.error = savedError
  }
}

for (const [name, test] of [
  ['common languages and ANSI render safely', assertLanguagesAndAnsi],
  ['custom TextMate grammars and aliases work', assertCustomLanguages],
  ['worker requests reuse results and discard stale queued work', assertClientCachingAndQueue],
  ['highlight cache has entry and byte limits', assertClientCacheBounds],
  ['hidden previews pause dispatch and resume current work', assertClientPauseAndResume],
  ['unavailable workers preserve escaped plain text', assertWorkerFailureFallback]
] as const) {
  await test()
  console.log(`ok - ${name}`)
}
