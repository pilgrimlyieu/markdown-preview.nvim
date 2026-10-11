export interface PlantumlOptions {
  imageFormat?: string
  server?: string
  openMarker?: string
  closeMarker?: string
}

export function plantumlPlaceholder (umlCode: string, pluginOptions: PlantumlOptions = {}, alt?: string) {
  const imageFormat = pluginOptions.imageFormat || 'img'
  const server = pluginOptions.server || 'https://www.plantuml.com/plantuml'
  const altAttribute = alt === undefined ? '' : ' data-alt="' + escape(alt) + '"'

  return '<div class="plantuml-diagram" data-server="' +
    escape(server) +
    '" data-image-format="' +
    escape(imageFormat) +
    '"' +
    altAttribute +
    '>' +
    escape(umlCode) +
    '</div>'
}
import { escape } from './utils'

