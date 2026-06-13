import Chart from 'chart.js'
import { replaceWithRenderError } from './utils'

export default function renderChartBlocks () {
  document.querySelectorAll('.chartjs').forEach(element => {
    try {
      // eslint-disable-next-line no-new
      new Chart(element, JSON.parse(element.textContent))
    } catch (e) {
      replaceWithRenderError(element, 'Chart.js', e)
    }
  })
}
