--- Lifecycle of the Node/Bun preview server.
---
--- One server is shared by every buffer unless `server.per_buffer` is set.
--- Browser requests wait for the server's ready callback, so opening several
--- buffers during startup never drops a preview.

local config = require("markdown-preview.config")
local util = require("markdown-preview.util")

local M = {}

---@class mkdp.OpenRequest
---@field bufnr integer
---@field requestId integer

---@class mkdp.Server
---@field channel integer
---@field ready boolean
---@field pending mkdp.OpenRequest[] browser requests waiting for startup

---@type table<string|integer, mkdp.Server> server key -> RPC job
local servers = {}

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
  local server = servers[key(bufnr)]
  return server and server.channel
end

--- Start the server owning `bufnr`, if necessary.
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
  local server = { channel = 0, ready = false, pending = {} }
  local channel = vim.fn.jobstart(cmd, {
    rpc = true,
    on_stderr = function(_, data)
      local lines = vim.tbl_filter(function(line)
        return line ~= ""
      end, data or {})
      if #lines > 0 then
        util.error(lines)
      end
    end,
    on_exit = function(job)
      if servers[owner] ~= server or server.channel ~= job then
        return
      end
      servers[owner] = nil
      require("markdown-preview.preview").on_server_exit(owner)
    end,
  })

  if channel <= 0 then
    util.error("failed to start the preview server: " .. table.concat(cmd, " "))
    return false
  end

  server.channel = channel
  servers[owner] = server
  return true
end

--- Called by the matching RPC job only after its HTTP and event handlers exist.
---@param channel integer
function M.ready(channel)
  for _, server in pairs(servers) do
    if server.channel == channel then
      server.ready = true
      local pending = server.pending
      server.pending = {}
      for _, request in ipairs(pending) do
        pcall(vim.rpcnotify, channel, "open_browser", request)
      end
      return
    end
  end
end

---@param owner string|integer
local function stop_channel(owner)
  local server = servers[owner]
  if not server then
    return
  end
  servers[owner] = nil
  if server.ready then
    pcall(vim.rpcrequest, server.channel, "close_all_pages")
  end
  pcall(vim.fn.jobstop, server.channel)
end

--- Stop the server owning `bufnr`, or every server when `bufnr` is omitted.
---@param bufnr? integer
function M.stop(bufnr)
  if bufnr then
    stop_channel(key(bufnr))
    return
  end
  for owner in pairs(vim.deepcopy(servers)) do
    stop_channel(owner)
  end
end

---@param bufnr integer
---@param method string
---@param payload table
function M.notify(bufnr, method, payload)
  local server = servers[key(bufnr)]
  if not server then
    return
  end
  if not server.ready then
    if method == "open_browser" or method == "close_page" then
      server.pending = vim.tbl_filter(function(request)
        return request.bufnr ~= bufnr
      end, server.pending)
      if method == "open_browser" then
        if config.get().combine.enabled then
          server.pending = { payload }
        else
          table.insert(server.pending, payload)
        end
      end
    end
    return
  end
  pcall(vim.rpcnotify, server.channel, method, payload)
end

return M
