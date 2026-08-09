local config = require("markdown-preview.config")
local util = require("markdown-preview.util")

local M = {}

---@param browser string|string[]
---@param url string
---@return string[]
local function command(browser, url)
  if type(browser) == "table" then
    return vim.list_extend(vim.deepcopy(browser), { url })
  end
  return { browser, url }
end

--- Hand the preview URL to whatever `config.browser` asks for.
---@param url string
function M.open(url)
  local opts = config.get()
  local browser = opts.browser

  local ok, err
  if type(browser) == "function" then
    ok, err = pcall(browser, url)
  elseif browser ~= nil and browser ~= "" then
    ok, err = pcall(vim.system, command(browser, url), { detach = true })
  else
    ok, err = pcall(vim.ui.open, url)
  end

  if not ok then
    util.error({ "failed to open " .. url, tostring(err) })
    return
  end

  if opts.echo_url then
    util.info("preview page: " .. url)
  end
end

return M
