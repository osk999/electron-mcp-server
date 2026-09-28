/**
 * Agent-facing body text. A page longer than the cap is marked as truncated
 * instead of ending at a silent character cut.
 */
export const BODY_TEXT_LIMIT = 12000;

export const SHAPE_BODY_TEXT_JS = `
function shapeBodyText(text, limit) {
  text = text == null ? '' : String(text);
  if (text.length <= limit) return text;
  var hidden = text.length - limit;
  return text.substring(0, limit) + '\\n[truncated, ' + hidden + ' more characters]';
}
`;

export function bodyTextExpression(limit: number = BODY_TEXT_LIMIT): string {
  return `(function() {
    ${SHAPE_BODY_TEXT_JS}
    var text = (document.body && document.body.innerText) || '';
    return shapeBodyText(text, ${limit});
  })()`;
}
