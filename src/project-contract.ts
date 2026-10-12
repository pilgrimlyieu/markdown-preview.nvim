/** Data shared by the project reader's HTTP routes and browser, without runtime imports. */
export interface FileTreeOptions {
  exclude?: string[]
  max_entries?: number
  max_text_bytes?: number
  max_image_bytes?: number
}

export interface DirectoryEntry {
  name: string
  /** Literal absolute path; realpath is only used for access checks. */
  path: string
  type: 'directory' | 'file' | 'unavailable'
  symlink?: boolean
  reason?: string
}

export interface DirectoryPage {
  root: string
  path: string
  entries: DirectoryEntry[]
  offset: number
  limit: number
  total: number
  truncated: boolean
}

interface FileReference {
  downloadUrl: string
  size?: number
}

export type FilePresentation = FileReference & (
  | { kind: 'text', language: string }
  | { kind: 'image', url: string }
  | { kind: 'attachment', message: string, openUrl?: string }
)

export type ProjectPreview<Payload> =
  | { kind: 'source', path: null }
  | { kind: 'markdown' | 'text' | 'image' | 'attachment', path: string, payload: Payload }
