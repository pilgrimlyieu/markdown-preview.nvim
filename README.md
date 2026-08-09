<h1 align="center"> ✨ Markdown Preview for Neovim ✨ </h1>

Preview Markdown in your browser, with the page following your cursor as you
edit.

A personal fork of [iamcco/markdown-preview.nvim][upstream], rewritten to be
Neovim-only and configured entirely from Lua: no VimScript layer, no
`g:mkdp_*` variables, and a TypeScript preview server and page built with Vite.

![animation of Markdown Preview with its own README.md](https://user-images.githubusercontent.com/5492542/47603494-28e90000-da1f-11e8-9079-30646e551e7a.gif)

## Requirements

- Neovim 0.10+
- [Bun](https://bun.sh) to build the plugin
- `bun` or `node` on `$PATH` to run the preview server

## Installation

`app/lib` and `app/out` are build artefacts and are not committed, so the build
has to run once after install and after every update.

With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "pilgrimlyieu/markdown-preview.nvim",
  build = "bun install --frozen-lockfile && bun run build-local",
  cmd = { "MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle" },
  opts = {},
}
```

`opts` is passed straight to `require("markdown-preview").setup()`. Calling
`setup` is optional — every option has a default.

### Replacing the upstream plugin

lazy.nvim identifies a plugin by name, and this fork keeps the repository name
it was forked from. On a distro that ships its own spec for
`markdown-preview.nvim` — LazyVim does, for [the upstream plugin][upstream] —
the two specs merge into one, so this fork inherits whatever `config`, `keys`
or `init` came with the other. LazyVim's `config` alone is enough to break
things: a spec that has one makes lazy.nvim run it *instead of* `setup`, and
every option above is silently dropped.

Give the fork a name of its own and the merge stops happening, which also
leaves `enabled = false` free to disable the spec being replaced:

```lua
{ "iamcco/markdown-preview.nvim", enabled = false },
{
  "pilgrimlyieu/markdown-preview.nvim",
  name = "markdown-preview",
  build = "bun install --frozen-lockfile && bun run build-local",
  cmd = { "MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle" },
  opts = {},
}
```

Keeping the shared name instead makes that `enabled = false` disable the fork
along with it.

## Usage

| Command                  | Lua                                       |
| ------------------------ | ----------------------------------------- |
| `:MarkdownPreview`       | `require("markdown-preview").open()`      |
| `:MarkdownPreviewStop`   | `require("markdown-preview").stop()`      |
| `:MarkdownPreviewToggle` | `require("markdown-preview").toggle()`    |
|                          | `require("markdown-preview").is_active()` |

The commands are global and work in any buffer, whatever its filetype. Each Lua
function takes an optional buffer number and defaults to the current buffer.

Run `:checkhealth markdown-preview` if a preview refuses to start.

## Configuration

Defaults, as declared in [`lua/markdown-preview/config.lua`](lua/markdown-preview/config.lua):

```lua
require("markdown-preview").setup({
  -- Open the preview when entering a matching buffer.
  auto_start = false,
  -- Close the preview page when the buffer is hidden.
  auto_close = true,
  -- Filetypes `auto_start` and `combine.auto_refresh` react to.
  filetypes = { "markdown" },
  -- Preview page title. `${name}` expands to the file name.
  page_title = "「${name}」",
  -- "dark" or "light". nil follows the system preference.
  theme = nil,
  -- Directory relative image links resolve against. nil uses the file's own.
  images_path = nil,
  -- How to open the preview URL. See "Choosing a browser" below.
  browser = nil,
  -- Echo the preview URL after opening it.
  echo_url = false,

  server = {
    -- Preferred port. nil picks a random one in the 8080-9079 range.
    port = nil,
    -- How many consecutive ports to try when `port` is taken.
    port_range = 32,
    -- One server per buffer, so several previews can stay live at once.
    per_buffer = false,
    -- Listen on 0.0.0.0 instead of 127.0.0.1.
    open_to_the_world = false,
    -- Host used to build the preview URL. Handy over SSH.
    open_ip = nil,
  },

  refresh = {
    -- Debounce for live refresh while typing, in ms. 0 disables it.
    debounce = 160,
    -- Events that trigger an immediate refresh. {} disables them.
    events = { "BufWritePost", "InsertLeave" },
  },

  scroll = {
    -- Sync the preview scroll position with the cursor.
    enabled = true,
    -- Throttle for cursor driven scroll sync, in ms. 0 sends every move.
    throttle = 40,
  },

  css = {
    -- Absolute paths to stylesheets replacing the built-in ones.
    markdown = nil,
    highlight = nil,
  },

  combine = {
    -- Reuse a single preview tab for every buffer. Pair with auto_close = false.
    enabled = false,
    -- Point that tab at the buffer you switch to.
    auto_refresh = true,
  },

  -- Handed to the preview page renderer.
  render = {
    -- Ignore scroll sync events in the browser.
    disable_sync_scroll = false,
    -- Where the cursor line lands: "middle", "top" or "relative".
    sync_scroll_type = "middle",
    -- Hide the YAML front matter.
    hide_yaml_meta = true,
    -- Make the preview page editable.
    content_editable = false,
    -- Hide the filename header.
    disable_filename = false,
    -- Also accepted, merged into the renderer defaults when set:
    --   mkit               markdown-it options
    --   katex              KaTeX options, e.g. { macros = { ... } }
    --   uml                PlantUML options: server, imageFormat, openMarker, closeMarker
    --   maid               mermaid options
    --   toc                markdown-it-toc-done-right options
    --   sequence_diagrams  js-sequence-diagrams options
    --   flowchart_diagrams flowchart.js options
  },
})
```

Tables merge into the defaults, but lists replace them: `filetypes = { "quarto" }`
means only `quarto`, and `refresh = { events = {} }` means no immediate refresh
events at all.

`render` is serialised and sent to the browser, so it may only hold data —
strings, numbers, booleans and tables. `browser` is the one option that stays on
the editor side and may be a function.

### Choosing a browser

`browser` accepts, in order of precedence:

```lua
-- A function, for full control.
browser = function(url)
  vim.fn.jobstart({ "firefox", "--new-window", url }, { detach = true })
end

-- A command with arguments. The URL is appended as the last argument.
browser = { "firefox", "--new-window" }

-- A bare command.
browser = "firefox"

-- nil hands the URL to `vim.ui.open`, which knows about xdg-open, open and WSL.
browser = nil
```

The command form spawns the process directly, so arguments containing spaces
need no escaping. On macOS, go through `open` explicitly:

```lua
browser = { "open", "-a", "Firefox", "-n", "--args", "--new-window" }
```

## What the page renders

On top of CommonMark with `html`, `linkify` and `typographer` enabled:

| Fenced block                        | Rendered by                                                           |
| ----------------------------------- | --------------------------------------------------------------------- |
| `mermaid`                           | [Mermaid](https://github.com/mermaid-js/mermaid)                      |
| `plantuml`, or an `@startuml` block | [PlantUML](https://plantuml.com)                                      |
| `chart` — body is Chart.js JSON     | [Chart.js](https://github.com/chartjs/Chart.js)                       |
| `dot`, `graphviz`                   | [Graphviz](https://github.com/mdaines/viz-js)                         |
| `flowchart`                         | [flowchart.js](https://github.com/adrai/flowchart.js)                 |
| `sequence-diagrams`                 | [js-sequence-diagrams](https://github.com/bramp/js-sequence-diagrams) |

A fence whose first line is `gantt`, `sequenceDiagram`, `erDiagram` or
`graph TD` is treated as Mermaid even without an info string. PlantUML blocks
become an `<img>` pointing at `https://www.plantuml.com/plantuml`, so the
diagram source leaves your machine; point `render.uml.server` at your own
instance to keep it local.

Also available:

- `$…$` and `$$…$$` maths via [KaTeX](https://github.com/KaTeX/KaTeX), with the
  mhchem extension loaded on demand
- A table of contents at `${toc}`, `[toc]`, `[[toc]]` or `[[_toc_]]`, and
  permalink anchors on every heading
- Image sizing: `![img](path.png =400x200)`
- Local images, resolved against the file's own directory or `images_path`
- Task lists, footnotes, definition lists, emoji shortcodes, and `!!!`
  admonitions
- Syntax highlighting via highlight.js

Everything heavy — highlight.js, KaTeX, Mermaid, Chart.js, Graphviz — is
code-split and only fetched once a document actually uses it.

## FAQ

#### *Why is the synchronised scrolling lagging?*

Lower `scroll.throttle`. Sync is driven by `CursorMoved`/`CursorMovedI`, so it
does not depend on `updatetime`.

#### *Why does the page not update while I type?*

`refresh.debounce` waits for a pause in typing. Lower it, or set it to `0` to
refresh only on `refresh.events`.

#### *How do I change the dark/light theme?*

The default follows your system preference. There is a toggle in the page
header — hover over it to reveal it. Set `theme = "dark"` or `"light"` to pin
it. Note that `render.disable_filename` hides the header, and the toggle with
it.

#### *Can I preview several files at once?*

Set `server.per_buffer = true`. Each buffer then gets its own server and port,
so previews stay live in parallel instead of taking turns. Otherwise one server
is shared, and `:MarkdownPreviewStop` in any buffer stops all of them.

#### *Where are the server logs?*

`$TMPDIR/mkdp-nvim.log`. Override with `NVIM_MKDP_LOG_FILE`, and raise the
verbosity with `NVIM_MKDP_LOG_LEVEL=debug`.

## Development

```sh
bun run typecheck   # tsc over the server and the page
bun run build-local # clean, then build app/lib and app/out
bun run test        # render, route, config and Neovim integration tests
```

`build-local` cleans first on purpose: `tsc` never removes stale output, so a
deleted source would otherwise linger in `app/lib` and still be loadable.

`nvim -u test/init.lua test/test.md` opens a scratch Neovim with the plugin
loaded, for trying changes by hand.

### Layout

```
lua/markdown-preview/
  init.lua      public API: setup, open, stop, toggle, is_active
  config.lua    defaults, merge, and the g:mkdp_config mirror for the server
  preview.lua   per-buffer lifecycle, payloads, refresh and scroll autocmds
  server.lua    editor -> server: job lifecycle and RPC notifications
  rpc.lua       server -> editor: the entry points the server calls back into
  browser.lua   opening the preview URL
  health.lua    :checkhealth markdown-preview
src/            the preview server, entered at main.ts, built to app/lib
app/src/        the preview page, built to app/out
app/_static/    assets served straight from disk; see app/_static/README.md
```

The Lua config table is the single source of truth. Everything the server needs
is mirrored into `g:mkdp_config`, which `src/config.ts` is the only reader of.
Neovim starts the server as an RPC job, the server serves the page over HTTP and
pushes content and scroll events to it over a WebSocket, and the editor — not
the server — is what opens the browser.

## Credits

[markdown-preview.nvim][upstream] by 年糕小豆汤, MIT licensed, along with
everything it builds on: [markdown-it](https://github.com/markdown-it/markdown-it)
and its plugin ecosystem, [markdown.css](https://github.com/iamcco/markdown.css),
[KaTeX](https://github.com/KaTeX/KaTeX), [highlight.js](https://github.com/highlightjs/highlight.js),
[Mermaid](https://github.com/mermaid-js/mermaid), [Chart.js](https://github.com/chartjs/Chart.js),
[viz.js](https://github.com/mdaines/viz-js), [flowchart.js](https://github.com/adrai/flowchart.js),
[js-sequence-diagrams](https://github.com/bramp/js-sequence-diagrams),
[@chemzqm/neovim](https://github.com/neoclide/neovim), [ws](https://github.com/websockets/ws)
and [Vite](https://github.com/vitejs/vite).

[upstream]: https://github.com/iamcco/markdown-preview.nvim
