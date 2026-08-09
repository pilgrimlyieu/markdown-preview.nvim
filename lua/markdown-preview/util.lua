local M = {}

--- Absolute path of the plugin root, the directory holding `lua/` and `app/`.
M.root = vim.fs.normalize(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h"))

---@param msg string|string[]
---@param level integer
local function notify(msg, level)
  local text = type(msg) == "table" and table.concat(msg, "\n") or tostring(msg)
  vim.notify("markdown-preview: " .. text, level, { title = "markdown-preview" })
end

---@param msg string|string[]
function M.error(msg)
  notify(msg, vim.log.levels.ERROR)
end

---@param msg string|string[]
function M.info(msg)
  notify(msg, vim.log.levels.INFO)
end

return M
