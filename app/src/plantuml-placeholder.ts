export interface PlantumlOptions {
  imageFormat?: string
  server?: string
  openMarker?: string
  closeMarker?: string
}

function escapeHtml (value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

export function plantumlPlaceholder (umlCode: string, pluginOptions: PlantumlOptions = {}, alt?: string) {
  const imageFormat = pluginOptions.imageFormat || 'img'
  const server = pluginOptions.server || 'https://www.plantuml.com/plantuml'
  const altAttribute = alt === undefined ? '' : ' data-alt="' + escapeHtml(alt) + '"'

  return '<div class="plantuml-diagram" data-server="' +
    escapeHtml(server) +
    '" data-image-format="' +
    escapeHtml(imageFormat) +
    '"' +
    altAttribute +
    '>' +
    escapeHtml(umlCode) +
    '</div>'
}
