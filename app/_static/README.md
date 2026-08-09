# `app/_static`

Assets served straight from disk by `src/routes.ts`, outside the Vite bundle.

## Plugin assets

`page.css`, `markdown.css`, `highlight.css`, `admonition.css` and `favicon.ico`
belong to the plugin. `markdown.css` and `highlight.css` are the two files
`css.markdown` / `css.highlight` can override.

## Vendored libraries — do not "modernise" these

`sequence-diagram-min.js` and `flowchart@1.13.0.min.js` are loaded at runtime
with `<script src>` and publish globals (`window.Diagram`, `window.flowchart`)
that `app/src/diagram.ts` and `app/src/flowchart.ts` read. They are checked in
rather than installed because:

- **js-sequence-diagrams is not installable.** On npm the name resolves to
  `0.0.1-security`, a placeholder with no usable release. Its dependency chain
  is vendored alongside it for the same reason: `underscore-min.js`,
  `webfont.js`, `snap.svg.min.js` and `tweenlite.min.js` exist only to set up
  the globals it expects, so moving them to npm on their own buys nothing.
  `fonts/danielbd.*` is its handwriting font, referenced by
  `sequence-diagram-min.css`.
- **flowchart.js is installable but not worth moving.** npm has 1.18.0 against
  the 1.13.0 here, but it needs a global `Raphael`, so switching trades ~120 kB
  of repository size for a rewrite of the loading path.

Anything that *is* a healthy npm package belongs in `package.json` instead —
mermaid, chart.js, KaTeX and Graphviz (`@viz-js/viz`) all go through Vite and
are code-split on demand. KaTeX fonts used to be vendored here too; Vite now
emits them from the npm package, so they were removed.
