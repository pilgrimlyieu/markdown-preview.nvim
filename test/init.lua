-- Manual harness: nvim -u test/init.lua test/test.md
vim.opt.runtimepath:append(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h"))

-- vim.env.NVIM_MKDP_LOG_FILE = vim.fn.expand("~/mkdp.log")
-- vim.env.NVIM_MKDP_LOG_LEVEL = "debug"

require("markdown-preview").setup({})
