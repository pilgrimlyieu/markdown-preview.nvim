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

### Reading project files

Click **Files** in the bottom toolbar to browse the project. Expand a directory,
then click a file to read it in the current page; Ctrl/Cmd-click or middle-click
opens another browser tab. This does not open buffers or move the cursor in
Neovim. Browser back and forward restore the document and reading position.

The tree starts at Neovim's effective working directory when the source buffer's
preview is first activated, including window-local `:lcd` and tab-local `:tcd`.
Later `:cd` calls do not move that root; stop and reopen the preview to capture a
new one. The tree is closed by default and only reads directories you expand.
**Refresh tree** rereads the listing; **Filter shown files** filters entries
already loaded, without searching the rest of the project.

| Selected file | Preview |
| --- | --- |
| Markdown | The normal Markdown renderer, including diagrams and relative links |
| Source code, configuration, UTF-8 text, HTML source | Literal text with syntax highlighting where supported |
| Browser-supported images, including SVG | An image view |
| PDF | File information, download, and **Open in browser** |
| Other binary files or files exceeding the preview limits | File information and download |

Files you read are snapshots: loaded buffers supply their unsaved text, otherwise
the file comes from disk. **Refresh file** reads again and keeps your position;
an error leaves the current view intact. Downloads use the saved file on disk.
**Back to source** fetches the latest source-buffer content and resumes live
updates. Selecting the source file itself also returns to its live preview.

These reading tabs belong to the source buffer. Set `auto_close = false` to keep
them open when that buffer is hidden; deleting/unloading the buffer or stopping
its preview still closes its tabs. With `combine.enabled`, live pages follow
buffer changes and update their trees, while pages reading another file stay
with their original source until you return to it.

Text previews default to 2 MiB and image previews to 20 MiB. Large files are
available as streamed downloads without loading them into the preview. Directory
pages show up to 200 entries; the browser keeps at most 2,000 rows and 32 expanded
directories. A directory scan examines at most `file_tree.max_entries` entries
and reports when that limit is reached. Pagination bounds display size, but
enumerating and sorting a directory still costs time proportional to its size.
There is no recursive scan or file watcher.

The tree's file and resource APIs restrict paths to the captured root, including
symlink targets. Existing Markdown links and `images_path` keep their previous
path resolution, including access outside that root.

## Configuration

Defaults, as declared in [`lua/markdown-preview/config.lua`](lua/markdown-preview/config.lua):

```lua
require("markdown-preview").setup({
  -- Open the preview when entering a matching buffer.
  auto_start = false,
  -- Close the preview page when the buffer is hidden.
  -- Deleting or unloading the buffer always closes its preview.
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
    -- Optional process isolation. By default, previews share one server per Neovim.
    per_buffer = false,
    -- Stop after this many ms without browser connections. 0 keeps it running.
    idle_timeout = 30000,
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

  file_tree = {
    -- Exact names, at any level; not glob patterns or gitignore rules.
    -- Show hidden files does not override this list. {} excludes nothing.
    exclude = { ".git", ".jj", "node_modules", ".venv", "target", "dist", "build" },
    -- Maximum entries examined in a single directory.
    max_entries = 20000,
    -- Other files fall back to download when too large to preview.
    -- These limits do not apply to the original live source buffer.
    max_text_bytes = 2 * 1024 * 1024,
    max_image_bytes = 20 * 1024 * 1024,
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
    --   highlight          Shiki: languages (TextMate grammars), aliases
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
- Syntax highlighting via [Shiki](https://shiki.style), including Lua, Rust,
  Go, TypeScript/TSX, Python, C/C++, C#, Java, Bash, PowerShell, Vimscript,
  TOML, Nix, Typst, Vue and the rest of its bundled languages
- ANSI terminal output in `ansi` or `terminal` fences: 16/256/truecolor foregrounds
  and backgrounds, bold, dim, italic, underline, strikethrough and reverse video

Everything heavy — Shiki, KaTeX, Mermaid, Chart.js, Graphviz — is
code-split and only fetched once a document actually uses it.

### Following links

- Heading, table-of-contents and footnote links stay on the current page.
  Fragments also work when opening a preview URL directly.
- External web links open a new tab. Local attachments open in another tab or
  download according to their type; explicit HTML `target` and `download`
  attributes are respected.
- Local `.md`, `.markdown`, `.mdown` and `.mkd` links open in the current preview.
  Relative paths, `..` and `#heading` fragments resolve from the document being
  read. Images use that document's directory unless `images_path` is configured.
  Browser back and forward restore the previous document and reading position.

Paths starting with `/` first try the filesystem path, then the document's
directory and its parents. Images and attachment links use the same rule.
An unnamed buffer uses Neovim's current directory for relative paths.

Following a local link leaves Neovim's current buffer and cursor alone. Linked
documents are snapshots loaded when opened or reloaded: an already loaded
buffer supplies its unsaved text; otherwise the file is read from disk. The
original preview stays connected in the background. Returning to it resumes
live updates, while a missing file shows a message without replacing the page.

### Code highlighting

Use a language label on the fence, such as `lua`, `rust`, `js`, `tsx` or `bash`.
Labels are case-insensitive; unknown languages and unlabelled/`text` fences
remain plain text. Nested fences in lists and blockquotes work too.

Shiki runs in a Web Worker with a reusable Oniguruma engine. The page displays
escaped code immediately, then replaces only the blocks whose colors are ready.
Grammars load on demand; unchanged blocks reuse an LRU cache capped at 512
entries and 8 MiB of source plus generated HTML. Both GitHub light/dark palettes
are emitted together, so the theme toggle does not re-tokenize code.
Hidden previews pause further highlighting; a new document discards queued work
from the previous one while allowing its active block to finish.

To keep large logs and minified files responsive, blocks over 65,536 UTF-16 code
units remain plain text; lines over 2,000 code units skip tokenization, with a
10 ms tokenization budget per line. ANSI support interprets SGR styling, not
terminal cursor movement or screen editing. It expects actual escape characters;
this command creates a small previewable example:

```sh
printf '```ansi\n\033[1;32mOK\033[0m\n```\n' > /tmp/ansi-preview.md
```

Custom languages use [TextMate grammar JSON](https://shiki.style/guide/load-lang),
the same format used by VS Code syntax extensions. Load the file in Neovim and
pass its data through `render.highlight.languages`; `aliases` adds or overrides
fence labels without changing a grammar:

```lua
local grammar = vim.json.decode(table.concat(
  vim.fn.readfile(vim.fn.expand("~/.config/nvim/syntax/example.tmLanguage.json")),
  "\n"
))
grammar.name = "example" -- the fence label

require("markdown-preview").setup({
  render = {
    highlight = {
      languages = { grammar },
      aliases = { ex = "example", mylua = "lua" },
    },
  },
})
```

Bundled grammars include their embedded languages. For custom grammars, list
dependencies in `embeddedLangs` (language names or aliases) and supply any custom
dependencies in the same `languages` array. The existing `css.highlight` override also applies to Shiki's
`--shiki-light*` and `--shiki-dark*` CSS variables.

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

Set `auto_close = false` and open a preview in each buffer. They share one
server process and port per Neovim instance, with independent live updates.
`:MarkdownPreviewStop` and `:MarkdownPreviewToggle` affect only the current
buffer. With `combine.enabled = true`, stopping closes the entire combined
preview, including a tab that is reading a local link from an earlier buffer.
Keeping the same origin also lets browser pages reuse cached scripts,
stylesheets, fonts and language files.

Deleting or unloading a buffer closes its preview even with `auto_close = false`.
Stopping the last preview releases the server immediately. If browser pages are
closed directly, the server exits after `server.idle_timeout` milliseconds
without connections (30 seconds by default); reloading a page during this grace
period keeps it running. Set the timeout to `0` to keep preview URLs available
indefinitely, or increase it if browser startup or reconnects take longer.
Exiting Neovim releases its servers even after an editor crash.

`server.per_buffer = true` remains available for separate processes and ports,
at the cost of one runtime per previewed buffer. It is not needed for parallel
previews. Separate Neovim instances each own a server; page rendering and DOM
state belong to each browser page.

#### *Where are the server logs?*

`$TMPDIR/mkdp-nvim.log`. Override with `NVIM_MKDP_LOG_FILE`, and raise the
verbosity with `NVIM_MKDP_LOG_LEVEL=debug`.

## Development

```sh
bun run typecheck   # tsc over the server and the page
bun run build-local # clean, then build app/lib and app/out
bun run test        # render, route, config and Neovim integration tests
bun run test:browser # highlighting, links, rendering and project reading (Firefox and Neovim)
bun run test:links   # link navigation against a real Neovim preview server
bun run test:preview # escaping, delayed diagrams and scroll restoration
bun run test:lifecycle # shared servers, buffer removal, startup and idle cleanup
bun run test:files   # project roots, directory pages, file limits and resource routes
bun run test:project # file-tree navigation, refresh, keyboard and display in Firefox
```

`build-local` cleans first on purpose: `tsc` never removes stale output, so a
deleted source would otherwise linger in `app/lib` and still be loadable.

The browser test needs Playwright's Firefox installed once with
`bunx playwright-core install firefox`.

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
[KaTeX](https://github.com/KaTeX/KaTeX), [Shiki](https://github.com/shikijs/shiki),
[Mermaid](https://github.com/mermaid-js/mermaid), [Chart.js](https://github.com/chartjs/Chart.js),
[viz.js](https://github.com/mdaines/viz-js), [flowchart.js](https://github.com/adrai/flowchart.js),
[js-sequence-diagrams](https://github.com/bramp/js-sequence-diagrams),
[@chemzqm/neovim](https://github.com/neoclide/neovim), [ws](https://github.com/websockets/ws)
and [Vite](https://github.com/vitejs/vite).

[upstream]: https://github.com/iamcco/markdown-preview.nvim
