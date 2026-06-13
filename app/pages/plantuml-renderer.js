import plantumlEncoder from 'plantuml-encoder'
import { replaceWithRenderError } from './utils'

function plantumlUrl (umlCode, element) {
  const imageFormat = element.getAttribute('data-image-format') || 'img'
  const server = element.getAttribute('data-server') || 'https://www.plantuml.com/plantuml'

  return `${server}/${imageFormat}/${plantumlEncoder.encode(umlCode)}`
}

export default function renderPlantumlBlocks () {
  document.querySelectorAll('.plantuml-diagram').forEach((element) => {
    try {
      const image = document.createElement('img')
      image.src = plantumlUrl(element.textContent || '', element)
      image.alt = element.getAttribute('data-alt') || ''
      element.replaceWith(image)
    } catch (e) {
      replaceWithRenderError(element, 'PlantUML', e)
    }
  })
}
