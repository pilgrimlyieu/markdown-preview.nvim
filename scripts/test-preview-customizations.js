const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const MarkdownIt = require('markdown-it')
const markdownAdmonition = require('markdown-it-admon')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

function testAdmonitionRendering () {
  const md = new MarkdownIt({ html: true }).use(markdownAdmonition)

  const rendered = md.render([
    '!!! info Fingerprinting 的形式化定义',
    '    一个 fingerprinting 方案。',
    '    - 无假阴性',
    ''
  ].join('\n'))

  assert.match(rendered, /<div class="admonition info">/)
  assert.match(rendered, /<p class="admonition-title">Fingerprinting 的形式化定义<\/p>/)
  assert.match(rendered, /一个 fingerprinting 方案。/)
  assert.match(rendered, /<li>无假阴性<\/li>/)

  const emptyTitle = md.render([
    '!!! warning ""',
    '    empty title should not render quotes',
    ''
  ].join('\n'))

  assert.match(emptyTitle, /<div class="admonition warning">/)
  assert.doesNotMatch(emptyTitle, /admonition-title/)
  assert.doesNotMatch(emptyTitle, /&quot;&quot;|""/)
}

function testScrollSource () {
  const scrollSource = read('app', 'pages', 'scroll.js')

  assert.match(scrollSource, /function getDocumentOffsetTop/)
  assert.match(scrollSource, /getBoundingClientRect\(\)\.top \+ scrollTop/)
  assert.match(scrollSource, /distance > 0/)
  assert.doesNotMatch(scrollSource, /\.offsetTop\b/)
}

function testScrollRuntimeUsesDocumentOffset () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  const scrollCalls = []
  const lineElement = {
    offsetTop: 0,
    getBoundingClientRect: () => ({ top: 900 })
  }

  const context = {
    module: { exports: {} },
    window: { pageYOffset: 300 },
    document: {
      body: { scrollTop: 300 },
      documentElement: {
        scrollTop: 300,
        clientHeight: 600,
        scrollHeight: 2400
      },
      querySelector: (selector) => (
        selector === '[data-source-line="12"]' ? lineElement : null
      )
    },
    TweenLite: {
      to: (_element, _duration, options) => {
        scrollCalls.push(options.scrollTop)
      }
    },
    Power2: { easeOut: 'easeOut' }
  }

  vm.runInNewContext(source, context)
  context.module.exports.relative({
    cursor: 13,
    winline: 5,
    winheight: 10,
    len: 100
  })

  assert.deepStrictEqual(scrollCalls, [900, 900])
}

function testScrollRuntimeInterpolatesIndentedAdmonitionBody () {
  const source = read('app', 'pages', 'scroll.js')
    .replace('export default', 'module.exports =')

  const scrollCalls = []
  const anchors = {
    '[data-source-line="35"]': {
      offsetTop: 0,
      getBoundingClientRect: () => ({ top: 900 })
    },
    '[data-source-line="37"]': {
      offsetTop: 0,
      getBoundingClientRect: () => ({ top: 1100 })
    }
  }

  const context = {
    module: { exports: {} },
    window: { pageYOffset: 300 },
    document: {
      body: { scrollTop: 300 },
      documentElement: {
        scrollTop: 300,
        clientHeight: 600,
        scrollHeight: 2400
      },
      querySelector: (selector) => anchors[selector] || null
    },
    TweenLite: {
      to: (_element, _duration, options) => {
        scrollCalls.push(options.scrollTop)
      }
    },
    Power2: { easeOut: 'easeOut' }
  }

  vm.runInNewContext(source, context)
  context.module.exports.middle({
    cursor: 37,
    len: 1258
  })

  assert.deepStrictEqual(scrollCalls, [1000, 1000])
}

function testBuiltPreviewBundle () {
  const html = read('app', 'out', 'index.html')
  assert.match(html, /\/_static\/admonition\.css/)

  const staticRoot = path.join(root, 'app', 'out', '_next', 'static')
  const pageBundle = fs
    .readdirSync(staticRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(staticRoot, entry.name, 'pages', 'index.js'))
    .find((candidate) => fs.existsSync(candidate))

  assert.ok(pageBundle, 'expected built Next.js pages/index.js bundle')

  const bundle = fs.readFileSync(pageBundle, 'utf8')
  assert.match(bundle, /getBoundingClientRect\(\)\.top/)
  assert.match(bundle, /admonition\.css/)
}

function testRuntimeSelection () {
  const rpc = read('autoload', 'mkdp', 'rpc.vim')
  const bunIndex = rpc.indexOf("elseif executable('bun')")
  const nodeIndex = rpc.indexOf("elseif executable('node')")

  assert.ok(bunIndex > -1, 'expected Bun runtime branch')
  assert.ok(nodeIndex > -1, 'expected Node runtime fallback branch')
  assert.ok(bunIndex < nodeIndex, 'expected Bun to be tried before Node')
}

function testBunCompatibleModuleLoader () {
  const loader = path.join(root, 'app', 'lib', 'app', 'load.js')
  assert.ok(fs.existsSync(loader), 'expected built app/lib/app/load.js')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdp-loader-'))
  const entry = path.join(tmp, 'entry.js')

  fs.writeFileSync(path.join(tmp, 'local.js'), "exports.value = 'ok'\n")
  fs.writeFileSync(entry, [
    "const path = require('path')",
    "const local = require('./local')",
    "module.exports = { basename: path.basename(__filename), value: local.value }",
    ''
  ].join('\n'))

  const script = [
    `const load = require(${JSON.stringify(loader)}).default`,
    `const result = load(${JSON.stringify(entry)})`,
    "if (result.basename !== 'entry.js' || result.value !== 'ok') {",
    "  console.error(JSON.stringify(result))",
    '  process.exit(1)',
    '}'
  ].join('\n')

  childProcess.execFileSync('bun', ['-e', script], {
    cwd: root,
    stdio: 'pipe'
  })
}

function testMermaidStaticRuntime () {
  const mermaid = read('app', '_static', 'mermaid.min.js')
  assert.match(mermaid, /version:"11\.15\.0"/)
  assert.match(mermaid, /globalThis\["mermaid"\]/)

  const page = read('app', 'pages', 'index.jsx')
  assert.match(page, /typeof mermaid\.run === 'function'/)
  assert.match(page, /mermaid\.run\({ nodes: mermaidNodes }\)/)
  assert.match(page, /mermaid\.init\(undefined, mermaidNodes\)/)
}

function testBuildCacheHygiene () {
  const gitignore = read('.gitignore')
  assert.match(gitignore, /\*\.tsbuildinfo/)

  const tracked = childProcess.execFileSync('git', ['ls-files', 'app/tsconfig.tsbuildinfo'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  assert.strictEqual(tracked, '')

  childProcess.execFileSync('git', ['check-ignore', '-q', 'app/tsconfig.tsbuildinfo'], {
    cwd: root,
    stdio: 'ignore'
  })
}

testAdmonitionRendering()
testScrollSource()
testScrollRuntimeUsesDocumentOffset()
testScrollRuntimeInterpolatesIndentedAdmonitionBody()
testBuiltPreviewBundle()
testRuntimeSelection()
testBunCompatibleModuleLoader()
testMermaidStaticRuntime()
testBuildCacheHygiene()

console.log('preview customization checks passed')
