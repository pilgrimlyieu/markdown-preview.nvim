local M = {}

--- Autocommands that depend on user options, so they are (re)built by `setup`.
--- The always-on ones live in `plugin/markdown-preview.lua`.
---@param opts mkdp.Config
local function auto_commands(opts)
  local group = vim.api.nvim_create_augroup("markdown-preview.auto", { clear = true })

  local action
  if opts.auto_start then
    action = function(bufnr)
      require("markdown-preview.preview").open(bufnr)
    end
  elseif opts.combine.enabled and opts.combine.auto_refresh then
    action = function()
      require("markdown-preview.preview").refocus()
    end
  else
    return
  end

  vim.api.nvim_create_autocmd("BufEnter", {
    group = group,
    callback = function(args)
      if vim.tbl_contains(opts.filetypes, vim.bo[args.buf].filetype) then
        action(args.buf)
      end
    end,
  })
end

--- Optional: the defaults work without it. Call it to change any of them.
---@param opts? mkdp.Config
function M.setup(opts)
  auto_commands(require("markdown-preview.config").setup(opts))
end

--- Open the preview for a buffer, defaulting to the current one.
---@param bufnr? integer
function M.open(bufnr)
  require("markdown-preview.preview").open(bufnr)
end

--- Stop the preview server behind a buffer.
---@param bufnr? integer
function M.stop(bufnr)
  require("markdown-preview.preview").stop(bufnr)
end

---@param bufnr? integer
function M.toggle(bufnr)
  require("markdown-preview.preview").toggle(bufnr)
end

---@param bufnr? integer
---@return boolean
function M.is_active(bufnr)
  return require("markdown-preview.preview").is_active(bufnr)
end

return M
