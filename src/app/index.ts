import load from './load'
import path from 'path'

const PATH = '--path'
const VERSION = '--version'

interface ServerEntry {
  run: () => void
}

const isServerEntry = (value: unknown): value is ServerEntry =>
  typeof value === 'object' &&
  value !== null &&
  'run' in value &&
  typeof (value as { run?: unknown }).run === 'function'

const appRoot = /^(\/|C:\\)snapshot/.test(__dirname)
  ? process.execPath.replace(/(markdown-preview.nvim.*?app).+?$/, '$1')
  : path.resolve(__dirname, '..', '..')

process.chdir(appRoot)

const { argv = [] }: { argv: string[] } = process

const param = argv[2]

if (param === PATH) {
  const entryPath = argv[3]
  if (!entryPath) {
    throw new Error('missing preview server entry path')
  }

  const entry = load(entryPath)
  if (!isServerEntry(entry)) {
    throw new Error(`preview server entry does not export run(): ${entryPath}`)
  }

  entry.run()
} else if (param === VERSION) {
  console.log('0.0.10')
}
