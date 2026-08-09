import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

import armasm from 'highlight.js/lib/languages/armasm'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import latex from 'highlight.js/lib/languages/latex'
import lisp from 'highlight.js/lib/languages/lisp'
import markdown from 'highlight.js/lib/languages/markdown'
import mathematica from 'highlight.js/lib/languages/mathematica'
import mipsasm from 'highlight.js/lib/languages/mipsasm'
import pgsql from 'highlight.js/lib/languages/pgsql'
import plaintext from 'highlight.js/lib/languages/plaintext'
import prolog from 'highlight.js/lib/languages/prolog'
import python from 'highlight.js/lib/languages/python'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import x86asm from 'highlight.js/lib/languages/x86asm'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const languages: Record<string, LanguageFn> = {
  armasm,
  bash,
  c,
  cpp,
  css,
  java,
  javascript,
  json,
  latex,
  lisp,
  markdown,
  mathematica,
  mipsasm,
  pgsql,
  plaintext,
  prolog,
  python,
  shell,
  sql,
  typescript,
  x86asm,
  xml,
  yaml
}

Object.keys(languages).forEach((name) => {
  hljs.registerLanguage(name, languages[name])
})

hljs.registerAliases(['assembly', 'asm'], { languageName: 'x86asm' })
hljs.registerAliases('mips', { languageName: 'mipsasm' })

export default hljs
