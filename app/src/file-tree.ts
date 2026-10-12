import type { DirectoryEntry, DirectoryPage } from '../../src/project-contract'
import type { PreviewLocation } from './preview-navigation'
import { ordinaryClick } from './utils'

const MAX_ROWS = 2000
const MAX_OPEN_DIRECTORIES = 32

interface Directory {
  path: string
  parent?: string
  page?: DirectoryPage
  request?: AbortController
  loading?: boolean
  error?: string
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

/** A bounded disclosure tree. Only an explicitly expanded directory is fetched. */
export class FileTree {
  private readonly lifetime = new AbortController()
  private readonly directories = new Map<string, Directory>()
  private readonly rootLabel = element('div')
  private readonly list = element('nav')
  private readonly hidden = element('input')
  private readonly filter = element('input')
  private visible = false
  private bufnr = 0
  private selected = ''

  constructor(private readonly panel: HTMLElement, private readonly actions: { open: (href: string) => void, close: () => void }) {
    panel.replaceChildren()
    const { signal } = this.lifetime
    const header = element('div')
    header.className = 'file-tree-header'
    const title = element('strong', 'Project files')
    const close = element('button', '×')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close file tree')
    close.addEventListener('click', actions.close, { signal })
    header.append(title, close)
    this.rootLabel.className = 'file-tree-root'
    const controls = element('div')
    controls.className = 'file-tree-controls'
    const refresh = element('button', 'Refresh tree')
    refresh.type = 'button'
    refresh.addEventListener('click', () => this.reset(true), { signal })
    const hiddenLabel = element('label')
    this.hidden.type = 'checkbox'
    this.hidden.addEventListener('change', () => this.reset(true), { signal })
    hiddenLabel.append(this.hidden, document.createTextNode(' Show hidden files'))
    this.filter.type = 'search'
    this.filter.placeholder = 'Filter shown files'
    this.filter.setAttribute('aria-label', 'Filter shown files')
    this.filter.addEventListener('input', () => this.render(), { signal })
    controls.append(refresh, hiddenLabel, this.filter)
    this.list.id = 'file-tree-entries'
    this.list.setAttribute('aria-label', 'Project file tree')
    this.list.addEventListener('keydown', event => this.onKey(event), { signal })
    // Some browsers still chain a wheel at the boundary of a fixed panel even
    // with overscroll-behavior. Keep that boundary (and the header) off the page,
    // while ordinary scrolling inside the list remains native.
    panel.addEventListener('wheel', event => {
      if (event.ctrlKey || !event.deltaY) return
      const inList = event.target instanceof Node && this.list.contains(event.target)
      const atEdge = event.deltaY < 0 ? this.list.scrollTop <= 0 :
        this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 1
      if (!inList || atEdge) event.preventDefault()
    }, { passive: false, signal })
    panel.append(header, this.rootLabel, controls, this.list)
  }

  setLocation(location: PreviewLocation) {
    this.selected = location.path || location.sourceName
    if (this.bufnr !== location.bufnr) {
      this.bufnr = location.bufnr
      this.rootLabel.textContent = ''
      this.reset(false)
    } else this.selectCurrent()
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      this.cancelRequests()
      return
    }
    if (!this.directories.has('')) this.directories.set('', { path: '' })
    this.render()
    for (const directory of this.directories.values()) {
      if (!directory.page && !directory.error) void this.load(directory)
    }
  }

  dispose() {
    this.visible = false
    this.cancelRequests()
    this.lifetime.abort()
    this.directories.clear()
  }

  private cancelRequests() {
    for (const directory of this.directories.values()) {
      directory.request?.abort()
      directory.request = undefined
      directory.loading = false
    }
  }

  private reset(fresh: boolean) {
    this.cancelRequests()
    this.directories.clear()
    const root: Directory = { path: '' }
    this.directories.set('', root)
    this.render()
    if (this.visible && this.bufnr) void this.load(root, 0, fresh)
  }

  private rows() {
    let rows = 0
    for (const directory of this.directories.values()) rows += directory.page?.entries.length || 0
    return rows
  }

  private collapse(path: string) {
    for (const directory of [...this.directories.values()]) {
      if (directory.parent === path) this.collapse(directory.path)
    }
    this.directories.get(path)?.request?.abort()
    this.directories.delete(path)
  }

  private async load(directory: Directory, offset = directory.page?.offset || 0, fresh = false) {
    if (!this.visible || !this.bufnr) return
    directory.request?.abort()
    const request = new AbortController()
    directory.request = request
    directory.error = undefined
    directory.loading = true
    this.render()
    const params = new URLSearchParams({ path: directory.path, offset: String(offset),
      hidden: this.hidden.checked ? '1' : '0', fresh: fresh ? '1' : '0' })
    try {
      const response = await fetch(`/api/files/${this.bufnr}?${params}`, { signal: request.signal })
      const page = await response.json() as DirectoryPage & { error?: string }
      if (!response.ok) throw new Error(page.error || 'Could not read this directory.')
      if (request.signal.aborted || this.directories.get(directory.path) !== directory) return
      if (this.rows() - (directory.page?.entries.length || 0) + page.entries.length > MAX_ROWS) {
        throw new Error('Too many files are shown. Collapse another folder, then retry.')
      }
      // Replacing a page also discards its descendants; pages never accumulate.
      for (const child of [...this.directories.values()]) {
        if (child.parent === directory.path) this.collapse(child.path)
      }
      directory.page = page
      this.rootLabel.textContent = page.root
      this.rootLabel.title = page.root
    } catch (error) {
      if (request.signal.aborted || this.directories.get(directory.path) !== directory) return
      directory.error = error instanceof Error ? error.message : 'Could not read this directory.'
    } finally {
      if (directory.request === request) {
        directory.request = undefined
        directory.loading = false
        if (this.visible) this.render()
      }
    }
  }

  private toggle(entry: DirectoryEntry, parent: string) {
    if (this.directories.has(entry.path)) {
      this.collapse(entry.path)
      this.render()
      return
    }
    if (this.directories.size >= MAX_OPEN_DIRECTORIES) {
      const message = this.list.querySelector<HTMLElement>('.file-tree-limit') || element('p')
      message.className = 'file-tree-limit'
      message.setAttribute('role', 'status')
      message.textContent = 'Collapse a folder before opening another one.'
      this.list.prepend(message)
      return
    }
    const directory = { path: entry.path, parent }
    this.directories.set(entry.path, directory)
    void this.load(directory)
  }

  private renderDirectory(directory: Directory): HTMLUListElement {
    const ul = element('ul')
    ul.dataset.directory = directory.path
    if (directory.loading) ul.setAttribute('aria-busy', 'true')
    const query = this.filter.value.toLocaleLowerCase()
    const page = directory.page
    for (const entry of page?.entries || []) {
      if (entry.type !== 'directory' && query && !entry.name.toLocaleLowerCase().includes(query)) continue
      const li = element('li')
      if (entry.type === 'directory') {
        const button = element('button')
        button.type = 'button'
        button.className = 'file-tree-entry file-tree-directory'
        button.dataset.treeKey = entry.path
        button.dataset.parent = directory.path
        button.setAttribute('aria-expanded', String(this.directories.has(entry.path)))
        const arrow = element('span', this.directories.has(entry.path) ? '▾' : '▸')
        arrow.setAttribute('aria-hidden', 'true')
        button.append(arrow, document.createTextNode(entry.name))
        button.title = entry.path
        button.addEventListener('click', () => this.toggle(entry, directory.path))
        li.append(button)
        const child = this.directories.get(entry.path)
        if (child) li.append(this.renderDirectory(child))
      } else if (entry.type === 'file') {
        const link = element('a', entry.name)
        link.className = 'file-tree-entry'
        link.dataset.treeKey = link.dataset.filePath = entry.path
        link.dataset.parent = directory.path
        link.href = `/page/${this.bufnr}?${new URLSearchParams({ path: entry.path, view: 'file' })}`
        link.title = entry.path
        link.addEventListener('click', event => {
          if (!ordinaryClick(event)) return
          event.preventDefault()
          this.actions.open(link.href)
        })
        li.append(link)
      } else {
        const unavailable = element('span', entry.name)
        unavailable.className = 'file-tree-unavailable'
        unavailable.title = entry.reason || 'Unavailable file'
        li.append(unavailable)
      }
      ul.append(li)
    }
    if (directory.loading || directory.error || (page && page.entries.length === 0)) {
      const status = element('li')
      status.className = 'file-tree-status'
      status.setAttribute('role', 'status')
      status.append(document.createTextNode(directory.error || (directory.loading ? 'Loading…' : 'No visible files.')))
      if (directory.error) {
        const retry = element('button', 'Retry')
        retry.type = 'button'
        retry.dataset.treeKey = `retry:${directory.path}`
        retry.addEventListener('click', () => { void this.load(directory, undefined, true) })
        status.append(retry)
      }
      ul.append(status)
    }
    if (page && page.total > page.limit) {
      const pager = element('li')
      pager.className = 'file-tree-pages'
      for (const [label, next, disabled] of [
        ['Previous page', page.offset - page.limit, page.offset === 0],
        ['Next page', page.offset + page.limit, page.offset + page.limit >= page.total]
      ] as const) {
        const button = element('button', label === 'Next page' ? 'Next' : 'Previous')
        button.type = 'button'
        button.setAttribute('aria-label', label)
        button.dataset.treeKey = `${label}:${directory.path}`
        button.disabled = disabled
        button.addEventListener('click', () => { void this.load(directory, next) })
        pager.append(button)
      }
      pager.append(element('span', `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total}`))
      ul.append(pager)
    }
    if (page?.truncated) {
      const notice = element('li', 'Only part of this folder was scanned. Increase file_tree.max_entries to list more.')
      notice.className = 'file-tree-status'
      ul.append(notice)
    }
    return ul
  }

  private render() {
    const active = this.list.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const activeKey = active?.dataset.treeKey
    const directory = active?.closest<HTMLElement>('ul[data-directory]')?.dataset.directory
    const paging = !!active?.closest('.file-tree-pages')
    const scrollTop = this.list.scrollTop
    const root = this.directories.get('')
    this.list.replaceChildren(...(root ? [this.renderDirectory(root)] : []))
    this.list.scrollTop = scrollTop
    this.selectCurrent()
    const entries = [...this.list.querySelectorAll<HTMLElement>('.file-tree-entry')]
    const controls = [...this.list.querySelectorAll<HTMLElement>('[data-tree-key]')].filter(node => !node.matches(':disabled'))
    const focus = controls.find(node => node.dataset.treeKey === activeKey) ||
      (paging && controls.find(node => node.closest('.file-tree-pages') && node.closest<HTMLElement>('ul[data-directory]')?.dataset.directory === directory)) ||
      entries.find(node => node.dataset.treeKey === directory) ||
      entries.find(node => node.getAttribute('aria-current') === 'page') || entries[0]
    const tabEntry = entries.includes(focus) ? focus : entries[0]
    for (const entry of entries) entry.tabIndex = entry === tabEntry ? 0 : -1
    if (activeKey) focus?.focus({ preventScroll: true })
  }

  private selectCurrent() {
    const windows = /^(?:[a-z]:[/\\]|\\\\)/i.test(this.rootLabel.title)
    const normalized = (filename: string) => windows ? filename.replace(/\\/g, '/').toLowerCase() : filename
    const selected = normalized(this.selected)
    for (const link of this.list.querySelectorAll<HTMLAnchorElement>('a[data-file-path]')) {
      if (normalized(link.dataset.filePath || '') === selected) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
  }

  private onKey(event: KeyboardEvent) {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.file-tree-entry') : null
    if (!target) return
    const entries = [...this.list.querySelectorAll<HTMLElement>('.file-tree-entry')]
    const index = entries.indexOf(target)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = entries[index + 1]
    else if (event.key === 'ArrowUp') next = entries[index - 1]
    else if (event.key === 'Home') next = entries[0]
    else if (event.key === 'End') next = entries[entries.length - 1]
    else if (event.key === 'ArrowRight' && target instanceof HTMLButtonElement) {
      if (target.getAttribute('aria-expanded') === 'false') target.click()
      else next = entries[index + 1]
    } else if (event.key === 'ArrowLeft') {
      if (target.getAttribute('aria-expanded') === 'true') target.click()
      else next = entries.find(node => node.dataset.treeKey === target.dataset.parent)
    } else return
    event.preventDefault()
    if (next) {
      for (const entry of entries) entry.tabIndex = entry === next ? 0 : -1
      next.focus()
    }
  }
}
