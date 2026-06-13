const neovim = require('@chemzqm/neovim')
const log4js = require('log4js')
const tslib = require('tslib')
const ws = require('ws')
const msgpackLite = require('msgpack-lite')

export default {
  '@chemzqm/neovim': neovim,
  log4js,
  tslib,
  ws,
  'msgpack-lite': msgpackLite
}
