import Chart from 'chart.js/auto'
import { replaceWithRenderError } from './utils'

export default function renderChartBlocks () {
  document.querySelectorAll('.chartjs').forEach(element => {
    try {
      // eslint-disable-next-line no-new
      new Chart(element as HTMLCanvasElement, JSON.parse(element.textContent || '{}'))
    } catch (e) {
      replaceWithRenderError(element, 'Chart.js', e)
    }
  })
}
