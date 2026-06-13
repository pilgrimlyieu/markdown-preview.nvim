let s:mkdp_root_dir = expand('<sfile>:h:h:h')
let s:mkdp_opts = {}
let s:is_vim = !has('nvim')
let s:shared_key = '__shared__'
let s:servers = {}
let s:sync_scroll_timers = {}

function! s:empty_channel() abort
  return s:is_vim ? v:null : -1
endfunction

function! s:server_key(bufnr) abort
  return get(g:, 'mkdp_multi_port', 0) ? string(a:bufnr) : s:shared_key
endfunction

function! s:empty_server(bufnr) abort
  return { 'bufnr': a:bufnr, 'channel': s:empty_channel() }
endfunction

function! s:get_server(bufnr) abort
  return get(s:servers, s:server_key(a:bufnr), s:empty_server(a:bufnr))
endfunction

function! s:set_server(bufnr, channel) abort
  let s:servers[s:server_key(a:bufnr)] = {
        \ 'bufnr': a:bufnr,
        \ 'channel': a:channel
        \ }
endfunction

function! s:clear_server(bufnr, channel) abort
  let l:key = s:server_key(a:bufnr)
  if has_key(s:servers, l:key) && string(s:servers[l:key].channel) ==# string(a:channel)
    call remove(s:servers, l:key)
  endif
endfunction

function! s:is_channel_active(channel) abort
  if s:is_vim
    return a:channel !=# v:null && job_status(a:channel) ==# 'run'
  endif
  return type(a:channel) == type(0) && a:channel > 0
endfunction

function! s:mark_buffer_stopped(bufnr) abort
  if bufexists(a:bufnr)
    call setbufvar(a:bufnr, 'MarkdownPreviewToggleBool', 0)
  endif
endfunction

function! s:sync_scroll_throttle() abort
  let l:value = get(g:, 'mkdp_sync_scroll_throttle', 40)
  let l:delay = type(l:value) == type(0) ? l:value : str2nr(l:value)
  return l:delay > 0 ? l:delay : 0
endfunction

function! s:clear_sync_scroll_timer(bufnr) abort
  let l:key = string(a:bufnr)
  if has_key(s:sync_scroll_timers, l:key)
    call timer_stop(s:sync_scroll_timers[l:key])
    call remove(s:sync_scroll_timers, l:key)
  endif
endfunction

function! s:clear_all_sync_scroll_timers() abort
  for l:key in keys(copy(s:sync_scroll_timers))
    call timer_stop(s:sync_scroll_timers[l:key])
    call remove(s:sync_scroll_timers, l:key)
  endfor
endfunction

function! s:sync_scroll_data(bufnr) abort
  return {
        \ 'bufnr': a:bufnr,
        \ 'data': {
        \   'options': get(g:, 'mkdp_preview_options', {}),
        \   'isActive': 1,
        \   'winline': winline(),
        \   'winheight': winheight(0),
        \   'cursor': getpos('.'),
        \   'len': line('$')
        \ }
        \ }
endfunction

function! s:send_sync_scroll(bufnr, ...) abort
  call s:clear_sync_scroll_timer(a:bufnr)
  if bufnr('%') !=# a:bufnr
    return
  endif
  call s:notify_server(a:bufnr, 'sync_scroll', s:sync_scroll_data(a:bufnr))
endfunction

function! s:on_stdout(chan_id, msgs, ...) abort
  call mkdp#util#echo_messages('Error', a:msgs)
endfunction
function! s:on_stderr(chan_id, msgs, ...) abort
  call mkdp#util#echo_messages('Error', a:msgs)
endfunction
function! s:on_exit(bufnr, chan_id, code, ...) abort
  call s:clear_server(a:bufnr, a:chan_id)
  call s:mark_buffer_stopped(a:bufnr)
endfunction

function! s:job_env(bufnr) abort
  let l:env = { 'MKDP_START_BUFNR': string(a:bufnr) }
  if s:is_vim
    let l:env['VIM_NODE_RPC'] = 1
  endif
  return l:env
endfunction

function! s:start_vim_server(cmd, bufnr) abort
  let options = {
        \ 'in_mode': 'json',
        \ 'out_mode': 'json',
        \ 'err_mode': 'nl',
        \ 'out_cb': function('s:on_stdout'),
        \ 'err_cb': function('s:on_stderr'),
        \ 'exit_cb': function('s:on_exit', [a:bufnr]),
        \ 'env': s:job_env(a:bufnr)
        \}
  if has("patch-8.1.350")
    let options['noblock'] = 1
  endif

  let l:job = job_start(a:cmd, options)
  if job_status(l:job) !=# 'run'
    echohl Error | echon 'Failed to start vim-node-rpc service' | echohl None
    return
  endif
  call s:set_server(a:bufnr, l:job)
endfunction

function! s:server_cmd() abort
  let l:mkdp_server_script = s:mkdp_root_dir . '/app/bin/markdown-preview-' . mkdp#util#get_platform()
  if executable(l:mkdp_server_script)
    return [l:mkdp_server_script, '--path', s:mkdp_root_dir . '/app/server.js']
  endif
  if executable('bun')
    return ['bun', s:mkdp_root_dir . '/app/index.js', '--path', s:mkdp_root_dir . '/app/server.js']
  endif
  if executable('node')
    return ['node', s:mkdp_root_dir . '/app/index.js', '--path', s:mkdp_root_dir . '/app/server.js']
  endif
  return []
endfunction

function! mkdp#rpc#start_server(...) abort
  let l:bufnr = get(a:, 1, bufnr('%'))
  if s:is_channel_active(s:get_server(l:bufnr).channel)
    return
  endif

  let l:cmd = s:server_cmd()
  if empty(l:cmd)
    call mkdp#util#echo_messages('Error', 'Pre build, bun, and node are not found')
    return
  endif

  if s:is_vim
    call s:start_vim_server(l:cmd, l:bufnr)
  else
    let l:opts = {
          \ 'rpc': 1,
          \ 'on_stdout': function('s:on_stdout'),
          \ 'on_stderr': function('s:on_stderr'),
          \ 'on_exit': function('s:on_exit', [l:bufnr]),
          \ 'env': s:job_env(l:bufnr)
          \ }
    let l:job = jobstart(l:cmd, l:opts)
    if l:job <= 0
      call mkdp#util#echo_messages('Error', 'Failed to start vim-node-rpc service')
      return
    endif
    call s:set_server(l:bufnr, l:job)
  endif
endfunction

function! s:stop_server(server) abort
  let l:channel = a:server.channel
  call s:clear_sync_scroll_timer(a:server.bufnr)
  if s:is_vim
    if s:is_channel_active(l:channel)
      try
        call mkdp#rpc#request(l:channel, 'close_all_pages')
      catch /.*/
      endtry
      try
        call job_stop(l:channel)
      catch /.*/
      endtry
    endif
  elseif s:is_channel_active(l:channel)
    try
      call rpcrequest(l:channel, 'close_all_pages')
    catch /.*/
    endtry
    try
      call jobstop(l:channel)
    catch /.*/
    endtry
  endif
  call s:clear_server(a:server.bufnr, l:channel)
  call s:mark_buffer_stopped(a:server.bufnr)
endfunction

function! mkdp#rpc#stop_server(...) abort
  if a:0
    call s:stop_server(s:get_server(a:1))
    return
  endif

  call s:clear_all_sync_scroll_timers()
  for l:server in values(copy(s:servers))
    call s:stop_server(l:server)
  endfor
endfunction

function! mkdp#rpc#get_server_status(...) abort
  let l:bufnr = get(a:, 1, bufnr('%'))
  return s:is_channel_active(s:get_server(l:bufnr).channel) ? 1 : -1
endfunction

function! s:notify_server(bufnr, method, args) abort
  let l:channel = s:get_server(a:bufnr).channel
  if !s:is_channel_active(l:channel)
    return
  endif

  if s:is_vim
    call mkdp#rpc#notify(l:channel, a:method, a:args)
  else
    call rpcnotify(l:channel, a:method, a:args)
  endif
endfunction

function! mkdp#rpc#preview_refresh() abort
  let l:bufnr = bufnr('%')
  call s:clear_sync_scroll_timer(l:bufnr)
  call s:notify_server(l:bufnr, 'refresh_content', { 'bufnr': l:bufnr })
endfunction

function! mkdp#rpc#preview_sync_scroll() abort
  let l:bufnr = bufnr('%')
  let l:delay = s:sync_scroll_throttle()
  if l:delay <= 0
    call s:send_sync_scroll(l:bufnr)
    return
  endif

  let l:key = string(l:bufnr)
  if !has_key(s:sync_scroll_timers, l:key)
    let s:sync_scroll_timers[l:key] = timer_start(l:delay, function('s:send_sync_scroll', [l:bufnr]))
  endif
endfunction

function! mkdp#rpc#preview_close() abort
  let l:bufnr = bufnr('%')
  call s:clear_sync_scroll_timer(l:bufnr)
  call s:notify_server(l:bufnr, 'close_page', { 'bufnr': l:bufnr })
  if get(g:, 'mkdp_multi_port', 0)
    call mkdp#rpc#stop_server(l:bufnr)
  else
    let b:MarkdownPreviewToggleBool = 0
  endif
  call mkdp#autocmd#clear_buf()
endfunction

function! mkdp#rpc#open_browser(...) abort
  let l:bufnr = get(a:, 1, bufnr('%'))
  call s:notify_server(l:bufnr, 'open_browser', { 'bufnr': l:bufnr })
endfunction

function! mkdp#rpc#request(clientId, method, ...) abort
  let args = get(a:, 1, [])
  let res = ch_evalexpr(a:clientId, [a:method, args], {'timeout': 5000})
  if type(res) == 1 && res ==# '' | return '' | endif
  let [l:errmsg, res] =  res
  if l:errmsg
    echohl Error | echon '[rpc.vim] client error: '.l:errmsg | echohl None
  else
    return res
  endif
endfunction

function! mkdp#rpc#notify(clientId, method, ...) abort
  let args = get(a:000, 0, [])
  " use 0 as vim request id
  let data = json_encode([0, [a:method, args]])
  call ch_sendraw(a:clientId, data."\n")
endfunction
