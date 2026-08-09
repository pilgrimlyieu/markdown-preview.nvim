--- Lifecycle of the Node/Bun preview server.
---
--- One server is shared by every buffer unless `server.per_buffer` is set, in
--- which case each buffer gets its own process and port.

local config = require("markdown-preview.config")
local util = require("markdown-preview.util")

local M = {}

---@type table<string|integer, integer> server key -> job channel
local channels = {}

---@param bufnr integer
---@return string|integer
local function key(bufnr)
  return config.get().server.per_buffer and bufnr or "shared"
end

--- The server is plain JS, so any JS runtime will do.
---@return string[]|nil
local function command()
  local entry = vim.fs.joinpath(util.root, "app", "lib", "main.js")
  if vim.fn.filereadable(entry) == 0 then
    return nil
  end
  for _, runtime in ipairs({ "bun", "node" }) do
    if vim.fn.executable(runtime) == 1 then
      return { runtime, entry }
    end
  end
  return nil
end

---@param bufnr integer
---@return integer|nil channel
function M.channel(bufnr)
  return channels[key(bufnr)]
end

--- Start the server owning `bufnr`. It opens the browser itself once listening.
---@param bufnr integer
---@return boolean started
function M.start(bufnr)
  if M.channel(bufnr) then
    return true
  end

  local cmd = command()
  if not cmd then
    util.error("no preview server found, run `bun install && bun run build-local` in " .. util.root)
    return false
  end

  local owner = key(bufnr)
  local channel = vim.fn.jobstart(cmd, {
    rpc = true,
    env = { MKDP_START_BUFNR = tostring(bufnr) },
    on_stderr = function(_, data)
      local lines = vim.tbl_filter(function(line)
        return line ~= ""
      end, data or {})
      if #lines > 0 then
        util.error(lines)
      end
    end,
    on_exit = function()
      channels[owner] = nil
      require("markdown-preview.preview").on_server_exit(owner)
    end,
  })

  if channel <= 0 then
    util.error("failed to start the preview server: " .. table.concat(cmd, " "))
    return false
  end

  channels[owner] = channel
  return true
end

---@param owner string|integer
local function stop_channel(owner)
  local channel = channels[owner]
  if not channel then
    return
  end
  channels[owner] = nil
  pcall(vim.rpcrequest, channel, "close_all_pages")
  pcall(vim.fn.jobstop, channel)
end

--- Stop the server owning `bufnr`, or every server when `bufnr` is omitted.
---@param bufnr? integer
function M.stop(bufnr)
  if bufnr then
    stop_channel(key(bufnr))
    return
  end
  for owner in pairs(vim.deepcopy(channels)) do
    stop_channel(owner)
  end
end

---@param bufnr integer
---@param method string
---@param payload table
function M.notify(bufnr, method, payload)
  local channel = M.channel(bufnr)
  if channel then
    pcall(vim.rpcnotify, channel, method, payload)
  end
end

return M
