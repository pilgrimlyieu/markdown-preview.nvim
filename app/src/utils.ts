export const escape = (str: string) => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const replaceWithRenderError = (element: Element, label: string, error: unknown) => {
  const message = document.createElement('pre')
  message.textContent = `${label} complains: "${error}"`
  element.replaceWith(message)
}
