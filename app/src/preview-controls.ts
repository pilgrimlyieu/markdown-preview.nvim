import type { FileTree } from './file-tree'
import type { PreviewLocation, PreviewNavigation } from './preview-navigation'
import { ordinaryClick } from './utils'

export class PreviewControls {
  private readonly main = document.querySelector('main')!
  private readonly toggle = document.querySelector<HTMLButtonElement>('#toggle-files')!
  private readonly panel = document.querySelector<HTMLElement>('#preview-files')!
  private readonly refresh = document.querySelector<HTMLButtonElement>('#refresh-file')!
  private readonly source = document.querySelector<HTMLAnchorElement>('#back-to-source')!
  private readonly name = document.querySelector<HTMLElement>('#reading-path')!
  private readonly backdrop = document.querySelector<HTMLButtonElement>('#files-backdrop')!
  private readonly lifetime = new AbortController()
  private location: PreviewLocation = { bufnr: 0, path: null, fileView: false, sourceName: '' }
  private tree: FileTree | null = null
  private loading: Promise<FileTree | null> | null = null
  private visible = false
  private disposed = false

  constructor(private readonly navigation: PreviewNavigation) {
    const { signal } = this.lifetime
    this.toggle.addEventListener('click', () => { void this.setVisible(!this.visible) }, { signal })
    this.refresh.addEventListener('click', () => { void navigation.refresh() }, { signal })
    this.source.addEventListener('click', event => {
      if (!ordinaryClick(event)) return
      event.preventDefault()
      void navigation.backToSource()
    }, { signal })
    this.backdrop.addEventListener('click', () => { void this.setVisible(false, true) }, { signal })
    document.addEventListener('keydown', event => {
      if (!this.visible) return
      if (event.key === 'Escape') {
        event.preventDefault()
        void this.setVisible(false, true)
      } else if (event.key === 'Tab' && window.innerWidth < 1280) {
        const controls = [...this.panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input')]
          .filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (first && (!this.panel.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }, { signal })
  }

  update(location: PreviewLocation) {
    this.location = location
    this.toggle.disabled = !location.bufnr
    this.refresh.hidden = this.source.hidden = this.name.hidden = !location.path
    this.source.href = `/page/${location.bufnr}`
    const path = location.path || ''
    this.name.textContent = path.length > 80 ? `…${path.slice(-79)}` : path
    this.name.title = location.path || ''
    this.tree?.setLocation(location)
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    this.tree?.dispose()
  }

  private async setVisible(visible: boolean, returnFocus = false) {
    if (this.disposed || (visible && !this.location.bufnr)) return
    this.visible = visible
    this.toggle.setAttribute('aria-expanded', String(visible))
    this.panel.hidden = this.backdrop.hidden = !visible
    this.main.classList.toggle('files-open', visible)
    this.tree?.setVisible(visible)
    if (!visible) {
      if (returnFocus) this.toggle.focus()
      return
    }
    if (!this.loading) {
      this.panel.textContent = 'Loading files…'
      this.loading = import('./file-tree').then(({ FileTree }) => {
        if (this.disposed) return null
        this.tree = new FileTree(this.panel, {
          open: href => {
            void this.navigation.open(href)
            if (window.innerWidth < 1280) void this.setVisible(false, true)
          },
          close: () => { void this.setVisible(false, true) }
        })
        return this.tree
      }).catch(() => {
        this.loading = null
        if (!this.disposed) this.panel.textContent = 'Could not load the file tree. Close and reopen Files to retry.'
        return null
      })
    }
    const tree = await this.loading
    if (!tree || this.disposed) return
    tree.setLocation(this.location)
    tree.setVisible(this.visible)
    if (this.visible && window.innerWidth < 1280) this.panel.querySelector<HTMLButtonElement>('button')?.focus()
  }
}
