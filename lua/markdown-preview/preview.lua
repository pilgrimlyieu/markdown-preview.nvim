--- Preview lifecycle for a single buffer: what gets sent to the server, and
--- which editor events trigger it.

local config = require("markdown-preview.config")
local server = require("markdown-preview.server")

local M = {}

---@type table<integer, integer> buffer -> latest requested preview identity
local active = {}
local next_request_id = 0

---@type table<integer, string> effective cwd at the start of each preview lifetime
local roots = {}

---@type table<integer, integer> buffer -> latest scheduled refresh
local refresh_ticket = {}

---@type table<integer, true> buffers with a scroll sync already queued
local scroll_queued = {}

---@param bufnr integer
---@return string
local function group_name(bufnr)
  return "markdown-preview." .. bufnr
end

--- Everything the preview page needs to place the viewport.
---
--- The window fields describe the current window, which is only the buffer's
--- own window when it is active. The page ignores scroll data unless
--- `isActive`, so an inactive buffer just reports its length.
---@param bufnr integer
---@return table
local function view(bufnr)
  local is_active = vim.api.nvim_get_current_buf() == bufnr
  return {
    options = config.get().render,
    isActive = is_active,
    winline = is_active and vim.fn.winline() or 1,
    winheight = is_active and vim.api.nvim_win_get_height(0) or 1,
    cursor = is_active and vim.fn.getpos(".") or { 0, 1, 1, 0 },
    len = vim.api.nvim_buf_line_count(bufnr),
  }
end

--- Full snapshot of a buffer. Also called by the preview server when a browser
--- tab connects, so it must tolerate any buffer number.
---@param bufnr integer
---@param include_content boolean
---@return table
function M.payload(bufnr, include_content)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return vim.empty_dict()
  end

  local opts = config.get()
  local payload = view(bufnr)
  payload.changedtick = vim.api.nvim_buf_get_changedtick(bufnr)
  payload.pageTitle = opts.page_title
  payload.theme = opts.theme or ""
  payload.name = vim.api.nvim_buf_get_name(bufnr)
  if include_content then
    payload.content = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  end
  return payload
end

---@param bufnr integer
local function send_refresh(bufnr)
  if vim.api.nvim_get_current_buf() ~= bufnr then
    return
  end
  scroll_queued[bufnr] = nil
  server.notify(bufnr, "refresh_content", { bufnr = bufnr, data = M.payload(bufnr, true) })
end

---@param bufnr integer
local function send_scroll(bufnr)
  if vim.api.nvim_get_current_buf() ~= bufnr then
    return
  end
  server.notify(bufnr, "sync_scroll", { bufnr = bufnr, data = view(bufnr) })
end

--- Trailing-edge debounce: only the last edit in a burst refreshes the page.
---@param bufnr integer
---@param delay integer
local function schedule_refresh(bufnr, delay)
  local ticket = (refresh_ticket[bufnr] or 0) + 1
  refresh_ticket[bufnr] = ticket
  vim.defer_fn(function()
    if refresh_ticket[bufnr] == ticket then
      send_refresh(bufnr)
    end
  end, delay)
end

--- Trailing-edge throttle: at most one scroll sync per `delay`.
---@param bufnr integer
---@param delay integer
local function schedule_scroll(bufnr, delay)
  if delay <= 0 then
    send_scroll(bufnr)
    return
  end
  if scroll_queued[bufnr] then
    return
  end
  scroll_queued[bufnr] = true
  vim.defer_fn(function()
    if scroll_queued[bufnr] then
      scroll_queued[bufnr] = nil
      send_scroll(bufnr)
    end
  end, delay)
end

---@param bufnr integer
local function attach(bufnr)
  local opts = config.get()
  local group = vim.api.nvim_create_augroup(group_name(bufnr), { clear = true })

  -- Deleted and unloaded buffers always release their preview, even when
  -- auto_close=false keeps previews of hidden buffers available.
  vim.api.nvim_create_autocmd({ "BufUnload", "BufDelete", "BufWipeout" }, {
    group = group,
    buffer = bufnr,
    callback = function()
      M.close(bufnr)
    end,
  })

  if opts.refresh.debounce > 0 then
    vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
      group = group,
      buffer = bufnr,
      callback = function()
        schedule_refresh(bufnr, opts.refresh.debounce)
      end,
    })
  end

  if #opts.refresh.events > 0 then
    -- The event names come from user config, so a bad one must not take the
    -- rest of the autocommands down with it.
    local ok, err = pcall(vim.api.nvim_create_autocmd, opts.refresh.events, {
      group = group,
      buffer = bufnr,
      callback = function()
        send_refresh(bufnr)
      end,
    })
    if not ok then
      require("markdown-preview.util").error({ "invalid `refresh.events`", tostring(err) })
    end
  end

  if opts.scroll.enabled then
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
      group = group,
      buffer = bufnr,
      callback = function()
        schedule_scroll(bufnr, opts.scroll.throttle)
      end,
    })
  end

  if opts.auto_close then
    vim.api.nvim_create_autocmd("BufHidden", {
      group = group,
      buffer = bufnr,
      callback = function()
        M.close(bufnr)
      end,
    })
  end
end

---@param bufnr integer
local function deactivate(bufnr)
  active[bufnr] = nil
  roots[bufnr] = nil
  refresh_ticket[bufnr] = nil
  scroll_queued[bufnr] = nil
  pcall(vim.api.nvim_del_augroup_by_name, group_name(bufnr))
end

---@param bufnr? integer
---@return boolean
function M.is_active(bufnr)
  return active[bufnr or vim.api.nvim_get_current_buf()] ~= nil
end

---@param bufnr integer
---@return string|nil
function M.project_root(bufnr)
  return active[bufnr] and roots[bufnr] or nil
end

--- A late browser callback must still belong to the current open request.
---@param bufnr integer
---@param request_id integer
---@return boolean
function M.is_current_request(bufnr, request_id)
  return request_id ~= nil and active[bufnr] == request_id
end

--- Start previewing a buffer. The server queues the browser request until ready.
---@param bufnr? integer
function M.open(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if not server.start(bufnr) then
    return
  end
  -- Capture lcd/tcd in the initiating window, before any asynchronous RPC.
  -- Reopening or combine refocus updates the request, not the project root.
  if not active[bufnr] then
    roots[bufnr] = vim.fn.getcwd()
  end
  next_request_id = next_request_id + 1
  active[bufnr] = next_request_id
  attach(bufnr)
  server.notify(bufnr, "open_browser", { bufnr = bufnr, requestId = next_request_id })
end

--- Stop this buffer's preview, or the single logical preview in combine mode.
---@param bufnr? integer
function M.stop(bufnr)
  local opts = config.get()
  if opts.combine.enabled and not opts.server.per_buffer then
    M.on_server_exit("shared")
    server.stop()
  else
    M.close(bufnr)
  end
end

--- Close one preview page, keeping a shared server alive for other buffers.
---@param bufnr? integer
function M.close(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if not active[bufnr] then
    return
  end
  server.notify(bufnr, "close_page", { bufnr = bufnr })
  deactivate(bufnr)
  if config.get().server.per_buffer or not next(active) then
    server.stop(bufnr)
  end
end

---@param bufnr? integer
function M.toggle(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if M.is_active(bufnr) then
    M.stop(bufnr)
  else
    M.open(bufnr)
  end
end

--- Point the shared preview tab at the current buffer, for `combine`.
function M.refocus()
  local bufnr = vim.api.nvim_get_current_buf()
  if server.channel(bufnr) and vim.g.mkdp_clients_active then
    M.open(bufnr)
  end
end

--- The server died, on its own or because we asked it to.
---@param owner string|integer
function M.on_server_exit(owner)
  if type(owner) == "number" then
    deactivate(owner)
    return
  end
  for bufnr in pairs(vim.deepcopy(active)) do
    deactivate(bufnr)
  end
end

return M
