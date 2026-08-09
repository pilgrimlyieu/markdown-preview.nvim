import { NeovimClient } from '@chemzqm/neovim'

/**
 * Mirror of the Lua config table, published as `g:mkdp_config` by
 * `lua/markdown-preview/config.lua`. Only the fields the server actually needs
 * are typed here; the rest stay on the editor side.
 */
export interface PreviewConfig {
  page_title?: string
  theme?: string
  images_path?: string
  server?: {
    port?: number
    port_range?: number
    per_buffer?: boolean
    open_to_the_world?: boolean
    open_ip?: string
  }
  css?: {
    markdown?: string
    highlight?: string
  }
  combine?: {
    enabled?: boolean
    auto_refresh?: boolean
  }
}

const EMPTY: PreviewConfig = {}

export async function getConfig(nvim: NeovimClient): Promise<PreviewConfig> {
  const value = await nvim.getVar('mkdp_config')
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PreviewConfig
    : EMPTY
}

export const asString = (value: unknown) => typeof value === 'string' ? value : ''
