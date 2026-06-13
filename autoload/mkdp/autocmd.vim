" init preview key action
function! mkdp#autocmd#init() abort
  execute 'augroup MKDP_REFRESH_INIT' . bufnr('%')
    autocmd!
    " refresh autocmd
    if g:mkdp_refresh_slow
      autocmd CursorHold,BufWrite,InsertLeave <buffer> call mkdp#rpc#preview_refresh()
    else
      autocmd CursorHold,CursorHoldI,BufWrite,InsertLeave <buffer> call mkdp#rpc#preview_refresh()
    endif
    if g:mkdp_sync_scroll_on_cursor
      autocmd CursorMoved,CursorMovedI <buffer> call mkdp#rpc#preview_sync_scroll()
    endif
    " autoclose autocmd
    if g:mkdp_auto_close
      autocmd BufHidden <buffer> call mkdp#rpc#preview_close()
    endif
    " server close autocmd
    autocmd VimLeave * call mkdp#rpc#stop_server()
  augroup END
endfunction

function! mkdp#autocmd#clear_buf() abort
  execute 'autocmd! ' . 'MKDP_REFRESH_INIT' . bufnr('%')
endfunction
