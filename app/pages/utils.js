export const escape = (str) => {
  // escape html content
  const d = document.createElement('div')
  d.appendChild(document.createTextNode(str))
  return d.innerHTML
}

export const replaceWithRenderError = (element, label, error) => {
  const message = document.createElement('pre')
  message.textContent = `${label} complains: "${error}"`
  element.replaceWith(message)
}
