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

--- bufnr(string) accepts patterns. Match names literally before resolving aliases.
---@param filename string
---@return integer|nil
local function loaded_buffer(filename)
  local normalized = vim.fs.normalize(filename, { expand_env = false })
  local names = {}
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buffer) then
      local name = vim.api.nvim_buf_get_name(buffer)
      if name ~= "" then
        if vim.fs.normalize(name, { expand_env = false }) == normalized then
          return buffer
        end
        names[buffer] = name
      end
    end
  end
  -- File IDs cover both symbolic links and hardlinks, as Neovim itself does.
  local target_stat = vim.uv.fs_stat(filename)
  if target_stat then
    for buffer, name in pairs(names) do
      local stat = vim.uv.fs_stat(name)
      if stat and stat.dev == target_stat.dev and stat.ino == target_stat.ino then
        return buffer
      end
    end
  end
end

--- Reading a link must not load a buffer or change the editor's current file.
--- Prefer an already loaded buffer so its unsaved edits are visible too.
---@param bufnr integer
---@param filename string
---@return table
function M.document(bufnr, filename)
  local target = loaded_buffer(filename)
  if target == bufnr then
    return { path = vim.NIL, payload = M.payload(bufnr, true) }
  end
  local payload = M.payload(bufnr, false)
  payload.name = filename
  payload.isActive = false
  if target then
    payload.content = vim.api.nvim_buf_get_lines(target, 0, -1, false)
  end
  return { path = filename, payload = payload }
end

return M
