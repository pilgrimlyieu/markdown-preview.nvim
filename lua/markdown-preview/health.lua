local util = require("markdown-preview.util")

local M = {}

function M.check()
  vim.health.start("markdown-preview")
  vim.health.info("Root: " .. util.root)

  local entry = vim.fs.joinpath(util.root, "app", "lib", "main.js")
  if vim.fn.filereadable(entry) == 0 then
    vim.health.error("Missing " .. entry, "run `bun install && bun run build-local` in " .. util.root)
    return
  end
  vim.health.info("Server: " .. entry)

  if vim.fn.isdirectory(vim.fs.joinpath(util.root, "app", "out")) == 0 then
    vim.health.error("The preview page has not been built", "run `bun run build-local` in " .. util.root)
    return
  end

  for _, runtime in ipairs({ "bun", "node" }) do
    if vim.fn.executable(runtime) == 1 then
      local result = vim.system({ runtime, "--version" }, { text = true }):wait()
      vim.health.ok(("Using %s %s"):format(runtime, vim.trim(result.stdout)))
      return
    end
  end

  vim.health.error("No JS runtime found", "install bun or node")
end

return M
