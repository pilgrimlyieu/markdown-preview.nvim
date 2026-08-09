--- The surface the preview server calls back into Neovim with, over
--- `nvim_exec_lua`. Kept in one module so the TypeScript side (`src/rpc.ts`)
--- has a single contract to hold on to.
---
--- The opposite direction, editor to server, lives in `server.lua`.

local M = {}

---@param lines string[]
function M.error(lines)
  require("markdown-preview.util").error(lines)
end

---@param url string
function M.open_url(url)
  require("markdown-preview.browser").open(url)
end

---@param bufnr integer
---@param include_content boolean
---@return table
function M.payload(bufnr, include_content)
  return require("markdown-preview.preview").payload(bufnr, include_content)
end

return M
