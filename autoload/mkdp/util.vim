let s:mkdp_root_dir = expand('<sfile>:h:h:h')
let s:pre_build = s:mkdp_root_dir . '/app/bin/markdown-preview-'

" echo message
function! mkdp#util#echo_messages(hl, msgs)
  if empty(a:msgs) | return | endif
  execute 'echohl '.a:hl
  if type(a:msgs) ==# 1
    echomsg a:msgs
  else
    for msg in a:msgs
      echom msg
    endfor
  endif
  echohl None
endfunction

" echo url
function! mkdp#util#echo_url(url)
  let l:url = 'Preview page: ' . a:url
  call mkdp#util#echo_messages('Type', l:url)
endfunction

" open preview page
function! mkdp#util#open_preview_page() abort
  let l:bufnr = bufnr('%')
  let l:server_status = mkdp#rpc#get_server_status(l:bufnr)
  if l:server_status ==# -1
    call mkdp#rpc#start_server(l:bufnr)
    call mkdp#autocmd#init()
  else
    call mkdp#util#open_browser(l:bufnr)
  endif
endfunction

" auto refetch combine preview
function! mkdp#util#combine_preview_refresh() abort
  if g:mkdp_clients_active && !g:mkdp_auto_start
    call mkdp#util#open_browser()
  endif
endfunction

" open browser
function! mkdp#util#open_browser(...) abort
  let l:bufnr = get(a:, 1, bufnr('%'))
  call mkdp#rpc#open_browser(l:bufnr)
  if l:bufnr ==# bufnr('%')
    call mkdp#autocmd#init()
  endif
endfunction

function! mkdp#util#stop_preview() abort
  let g:mkdp_clients_active = 0
  " TODO: delete autocmd
  if get(g:, 'mkdp_multi_port', 0)
    call mkdp#rpc#stop_server(bufnr('%'))
  else
    call mkdp#rpc#stop_server()
  endif
  let b:MarkdownPreviewToggleBool = 0
endfunction

function! mkdp#util#get_platform() abort
  if has('win32') || has('win64')
    return 'win'
  elseif has('mac') || has('macvim')
    if system('arch') =~? 'arm64'
      return 'macos-arm64'
    endif
    return 'macos'
  endif
  return 'linux'
endfunction

function! s:on_exit(autoclose, bufnr, Callback, job_id, status, ...)
  let content = join(getbufline(a:bufnr, 1, '$'), "\n")
  if a:status == 0 && a:autoclose == 1
    execute 'silent! bd! '.a:bufnr
  endif
  if !empty(a:Callback)
    call call(a:Callback, [a:status, a:bufnr, content])
  endif
endfunction

function! mkdp#util#open_terminal(opts) abort
  if get(a:opts, 'position', 'bottom') ==# 'bottom'
    let p = '5new'
  else
    let p = 'vnew'
  endif
  execute 'belowright '.p.' +setl\ buftype=nofile '
  setl buftype=nofile
  setl winfixheight
  setl norelativenumber
  setl nonumber
  setl bufhidden=wipe
  let cmd = get(a:opts, 'cmd', '')
  let autoclose = get(a:opts, 'autoclose', 1)
  if empty(cmd)
    throw 'command required!'
  endif
  let cwd = get(a:opts, 'cwd', '')
  if !empty(cwd) | execute 'lcd '.cwd | endif
  let keepfocus = get(a:opts, 'keepfocus', 0)
  let bufnr = bufnr('%')
  let Callback = get(a:opts, 'Callback', v:null)
  if has('nvim')
    call termopen(cmd, {
          \ 'on_exit': function('s:on_exit', [autoclose, bufnr, Callback]),
          \})
  else
    call term_start(cmd, {
          \ 'exit_cb': function('s:on_exit', [autoclose, bufnr, Callback]),
          \ 'curwin': 1,
          \})
  endif
  if keepfocus
    wincmd p
  endif
  return bufnr
endfunction

function! s:markdown_preview_installed(status, ...) abort
  if a:status != 0
    call mkdp#util#echo_messages('Error', '[markdown-preview]: install fail')
    return
  endif
  echo '[markdown-preview.nvim]: install completed'
endfunction

function! s:install_cmd() abort
  if executable('bun')
    return 'bun install --frozen-lockfile && bun run build-local'
  endif
  return ''
endfunction

function! mkdp#util#install(...)
  let l:cmd = s:install_cmd()
  if empty(l:cmd)
    call mkdp#util#echo_messages('Error', '[markdown-preview.nvim]: Bun is required to build this fork')
    return
  endif

  if get(a:, '1', v:false) ==# v:true
    execute 'lcd ' . fnameescape(s:mkdp_root_dir)
    execute '!' . l:cmd
  else
    call mkdp#util#open_terminal({
          \ 'cmd': l:cmd,
          \ 'cwd': s:mkdp_root_dir,
          \ 'Callback': function('s:markdown_preview_installed')
          \})
    wincmd p
  endif
endfunction

function! mkdp#util#install_sync(...)
  if get(a:, '1', v:false) ==# v:true
    silent call mkdp#util#install(v:true)
  else
    call mkdp#util#install(v:true)
  endif
endfunction

function! mkdp#util#pre_build_version() abort
  let l:pre_build = s:pre_build . mkdp#util#get_platform()
  if has('win32') || has('win64')
    let l:pre_build .= '.exe'
  endif
  if filereadable(l:pre_build)
    let l:info = system(l:pre_build . ' --version')
    if l:info ==# ''
      call mkdp#util#echo_messages('Type', "[markdown-preview.nvim]: Can not execute pre build binary bundle to get version, will download latest pre build binary bundle")
      return ''
    endif
    let l:info = split(l:info, '\n')
    return l:info[0]
  endif
  return ''
endfunction

function! mkdp#util#toggle_preview() abort
    if !get(b:, 'MarkdownPreviewToggleBool')
        call mkdp#util#open_preview_page()
        let b:MarkdownPreviewToggleBool=1
    else
        call mkdp#util#stop_preview()
        let b:MarkdownPreviewToggleBool=0
    endif
endfunction
