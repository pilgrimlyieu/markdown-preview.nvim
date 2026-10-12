import { NeovimClient, VimValue } from '@chemzqm/neovim'

import { BufferId, OpenEvent, PreviewPayload } from './app-contract'

/**
 * Calls into the editor. Every entry point lives in
 * `lua/markdown-preview/rpc.lua`, so this file is the whole server-to-editor
 * contract.
 */
const invoke = (nvim: NeovimClient, method: string, args: VimValue[]) =>
  nvim.lua(`return require("markdown-preview.rpc").${method}(...)`, args)

export const echoError = (nvim: NeovimClient, lines: string[]) =>
  invoke(nvim, 'error', [lines]).catch(() => {
    // The editor is the thing we report errors to, so there is nowhere left to go.
  })

export const openUrl = (nvim: NeovimClient, url: string, { bufnr, requestId }: OpenEvent) =>
  invoke(nvim, 'open_url', [url, Number(bufnr), requestId])

export const serverReady = async (nvim: NeovimClient) =>
  invoke(nvim, 'server_ready', [await nvim.channelId])

export const previewPayload = async (
  nvim: NeovimClient,
  bufnr: BufferId,
  includeContent: boolean
) => await invoke(nvim, 'payload', [Number(bufnr), includeContent]) as PreviewPayload

export const previewDocument = async (nvim: NeovimClient, bufnr: BufferId, filename: string) =>
  await invoke(nvim, 'document', [Number(bufnr), filename]) as { path: string | null, payload: PreviewPayload }
