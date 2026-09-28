/**
 * Page-overview shaping shared by the renderer script and unit tests.
 * Controls are named by their own visible text or aria-label. Utility class
 * strings are not part of the payload an agent reads.
 */
export const PAGE_OVERVIEW_HELPERS_JS = `
function ownVisibleText(el) {
  if (!el || !el.childNodes) return '';
  var parts = [];
  for (var i = 0; i < el.childNodes.length; i++) {
    var node = el.childNodes[i];
    if (node && node.nodeType === 3 && node.nodeValue) parts.push(node.nodeValue);
  }
  return parts.join('').replace(/\\s+/g, ' ').trim();
}

function controlName(el) {
  var aria = '';
  if (el && el.getAttribute) aria = el.getAttribute('aria-label') || '';
  aria = String(aria).trim();
  var own = ownVisibleText(el);
  var text = own || aria;
  if (!text) {
    var content = el && el.textContent ? String(el.textContent) : '';
    text = content.replace(/\\s+/g, ' ').trim();
    if (text.length > 80) text = text.substring(0, 77) + '...';
  }
  return { text: text, ariaLabel: aria };
}

function shapeOverviewControl(raw) {
  var text = raw && raw.text ? String(raw.text).trim() : '';
  var aria = raw && raw.ariaLabel ? String(raw.ariaLabel).trim() : '';
  var out = { text: text || aria, ariaLabel: aria };
  var keep = ['id', 'type', 'disabled', 'visible', 'placeholder', 'label', 'name', 'value', 'required', 'readOnly', 'href', 'target', 'options', 'selectedValue', 'multiple'];
  for (var i = 0; i < keep.length; i++) {
    var key = keep[i];
    if (raw && raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}
`;
