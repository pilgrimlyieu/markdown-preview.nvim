--- Configuration for the preview.
---
--- The resolved table is the single source of truth. Everything the preview
--- server needs is mirrored into `g:mkdp_config`, which is the only variable
--- the Node/Bun side reads (see `src/config.ts`).

---@class mkdp.RenderOptions Options handed to the preview page renderer.
---@field disable_sync_scroll? boolean Ignore scroll sync events in the browser.
---@field sync_scroll_type? "middle"|"top"|"relative" Where the cursor line lands on the page.
---@field hide_yaml_meta? boolean Hide the YAML front matter.
---@field content_editable? boolean Make the preview page editable.
---@field disable_filename? boolean Hide the filename header.
---@field mkit? table `markdown-it` options.
---@field katex? table KaTeX options, e.g. `{ macros = { ... } }`.
---@field uml? table `markdown-it-plantuml` options.
---@field maid? table Mermaid options.
---@field toc? table `markdown-it-toc-done-right` options.
---@field sequence_diagrams? table `js-sequence-diagrams` options.
---@field flowchart_diagrams? table `flowchart.js` options.

---@class mkdp.ServerConfig
---@field port? integer Preferred port. `nil` picks a random one.
---@field port_range? integer How many consecutive ports to try when `port` is taken.
---@field per_buffer? boolean Run one server per buffer so several previews stay live at once.
---@field open_to_the_world? boolean Listen on `0.0.0.0` instead of `127.0.0.1`.
---@field open_ip? string Host used to build the preview URL. Handy over SSH.

---@class mkdp.RefreshConfig
---@field debounce? integer Debounce for live refresh while typing, in ms. `0` disables it.
---@field events? string[] Events that trigger an immediate refresh.

---@class mkdp.ScrollConfig
---@field enabled? boolean Sync the preview scroll position with the cursor.
---@field throttle? integer Throttle for cursor driven scroll sync, in ms. `0` sends every move.

---@class mkdp.CssConfig
---@field markdown? string Absolute path to a stylesheet replacing the built-in markdown css.
---@field highlight? string Absolute path to a stylesheet replacing the built-in highlight css.

---@class mkdp.CombineConfig
---@field enabled? boolean Reuse a single preview tab for every buffer.
---@field auto_refresh? boolean Point that tab at the buffer you switch to.

---@class mkdp.Config
---@field auto_start? boolean Open the preview when entering a matching buffer.
---@field auto_close? boolean Close the preview page when the buffer is hidden.
---@field filetypes? string[] Filetypes `auto_start` and `combine.auto_refresh` react to.
---@field page_title? string Preview page title. `${name}` expands to the file name.
---@field theme? "dark"|"light" Preview theme. `nil` follows the system preference.
---@field images_path? string Directory relative image links resolve against.
---@field browser? string|string[]|fun(url: string) How to open the preview URL.
---@field echo_url? boolean Echo the preview URL after opening it.
---@field server? mkdp.ServerConfig
---@field refresh? mkdp.RefreshConfig
---@field scroll? mkdp.ScrollConfig
---@field css? mkdp.CssConfig
---@field combine? mkdp.CombineConfig
---@field render? mkdp.RenderOptions

---@type mkdp.Config
local defaults = {
  auto_start = false,
  auto_close = true,
  filetypes = { "markdown" },
  page_title = "「${name}」",
  theme = nil,
  images_path = nil,

  -- `browser` accepts, in order of precedence:
  --   fun(url)  full control, e.g. `function(url) vim.fn.jobstart({ "firefox", url }) end`
  --   string[]  command with arguments, e.g. `{ "firefox", "--new-window" }`
  --   string    bare command, e.g. `"firefox"`
  --   nil       hand the URL to `vim.ui.open`
  browser = nil,
  echo_url = false,

  server = {
    port = nil,
    port_range = 32,
    per_buffer = false,
    open_to_the_world = false,
    open_ip = nil,
  },

  refresh = {
    debounce = 160,
    events = { "BufWritePost", "InsertLeave" },
  },

  scroll = {
    enabled = true,
    throttle = 40,
  },

  css = {
    markdown = nil,
    highlight = nil,
  },

  combine = {
    enabled = false,
    auto_refresh = true,
  },

  render = {
    disable_sync_scroll = false,
    sync_scroll_type = "middle",
    hide_yaml_meta = true,
    content_editable = false,
    disable_filename = false,
  },
}

--- Deep merge, except that list defaults are replaced wholesale. Merging
--- `filetypes` index by index would leave leftovers from the default behind,
--- and `events = {}` has to mean "none" rather than "unchanged".
local function merge(base, override)
  if type(override) ~= "table" then
    return override
  end
  if type(base) ~= "table" or (vim.islist(base) and next(base) ~= nil) then
    return vim.deepcopy(override)
  end
  local out = vim.deepcopy(base)
  for key, value in pairs(override) do
    out[key] = merge(out[key], value)
  end
  return out
end

local M = {}

---@type mkdp.Config
local options = vim.deepcopy(defaults)

--- Mirror the config for the preview server. `browser` stays behind because it
--- may be a Lua function; opening the URL is the editor's job either way.
local function publish()
  local mirrored = vim.deepcopy(options)
  mirrored.browser = nil
  local ok, err = pcall(function()
    vim.g.mkdp_config = mirrored
  end)
  if not ok then
    require("markdown-preview.util").error({
      "config contains a value the preview server cannot read",
      tostring(err),
    })
  end
end

---@param opts? mkdp.Config
---@return mkdp.Config
function M.setup(opts)
  options = merge(defaults, opts or {})
  publish()
  return options
end

---@return mkdp.Config
function M.get()
  return options
end

publish()

return M
