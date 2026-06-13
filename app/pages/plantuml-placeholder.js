function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function plantumlPlaceholder (umlCode, pluginOptions, alt) {
  var options = pluginOptions || {}
  var imageFormat = options.imageFormat || 'img'
  var server = options.server || 'https://www.plantuml.com/plantuml'
  var altAttribute = alt === undefined ? '' : ' data-alt="' + escapeHtml(alt) + '"'

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

module.exports = {
  plantumlPlaceholder
}
