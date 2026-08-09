import { BufferId, PreviewApp, PreviewPayload } from '../app-contract'

export interface Notification {
  bufnr: BufferId
  data?: PreviewPayload
}

/**
 * What happened to a notification. Naming every outcome keeps the policy
 * testable without an editor on the other end of the socket.
 */
export type Dispatch =
  | 'dropped-before-init'
  | 'dropped-without-data'
  | 'dropped-without-clients'
  | 'ignored'
  | 'closed'
  | 'opened'
  | 'scrolled'
  | 'refreshed'

/** Route one editor notification to the preview app. */
export function dispatch(
  app: PreviewApp | undefined,
  method: string,
  { bufnr, data }: Notification
): Dispatch {
  if (!app) {
    return 'dropped-before-init'
  }

  if (method === 'close_page') {
    app.closePage({ bufnr })
    return 'closed'
  }
  if (method === 'open_browser') {
    app.openBrowser({ bufnr })
    return 'opened'
  }
  if (method !== 'refresh_content' && method !== 'sync_scroll') {
    return 'ignored'
  }

  // Payloads are always built by lua/markdown-preview/preview.lua.
  if (!data) {
    return 'dropped-without-data'
  }
  if (!app.hasClients({ bufnr })) {
    return 'dropped-without-clients'
  }

  // A refresh carrying content the page already has is only a viewport move.
  if (method === 'sync_scroll' || app.isContentFresh({ bufnr, changedtick: data.changedtick })) {
    app.syncScroll({ bufnr, data })
    return 'scrolled'
  }

  app.refreshPage({ bufnr, data })
  return 'refreshed'
}
