import Chart from 'chart.js/auto'
import { replaceWithRenderError } from './utils'

export default function renderChartBlocks (nodes: Iterable<HTMLCanvasElement>) {
  const charts: Chart[] = []
  for (const element of nodes) {
    if (Chart.getChart(element)) continue
    try {
      charts.push(new Chart(element, JSON.parse(element.textContent || '{}')))
    } catch (e) {
      // Chart.js registers the instance before validating its configuration.
      Chart.getChart(element)?.destroy()
      replaceWithRenderError(element, 'Chart.js', e)
    }
  }
  return charts.length ? () => charts.forEach(chart => chart.destroy()) : undefined
}
