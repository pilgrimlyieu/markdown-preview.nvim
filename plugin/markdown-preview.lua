if vim.g.loaded_markdown_preview then
  return
end
vim.g.loaded_markdown_preview = true

for name, action in pairs({
  MarkdownPreview = "open",
  MarkdownPreviewStop = "stop",
  MarkdownPreviewToggle = "toggle",
}) do
  vim.api.nvim_create_user_command(name, function()
    require("markdown-preview")[action]()
  end, { desc = "markdown-preview: " .. action })
end

vim.api.nvim_create_autocmd("VimLeavePre", {
  group = vim.api.nvim_create_augroup("markdown-preview", { clear = true }),
  callback = function()
    require("markdown-preview.server").stop()
  end,
})
