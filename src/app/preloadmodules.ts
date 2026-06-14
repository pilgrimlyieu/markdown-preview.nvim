const neovim = require('@chemzqm/neovim')
const log4js = require('log4js')
const tslib = require('tslib')
const ws = require('ws')
const msgpackLite = require('msgpack-lite')

const modules: { [name: string]: unknown } = {
  '@chemzqm/neovim': neovim,
  log4js,
  tslib,
  ws,
  'msgpack-lite': msgpackLite
}

export default modules
