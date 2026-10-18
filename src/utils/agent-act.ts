/**
 * One renderer script for a short batch of UI steps.
 * Key presses stay on the CDP path in the command module. Everything else
 * (click, fill, select, hover, scroll, wait) runs here, then the caller
 * takes a fresh snapshot.
 */
import { CLICK_BY_TEXT_MIN_TEXT_SCORE } from '../constants';
import { TEXT_MATCH_HELPERS_JS } from './text-matching';
import { PAGE_AGENT_JS } from './agent-page';
import { clipText, unwrapEvaluateString } from './agent-snapshot';

export type AgentActStep = {
  action: 'click' | 'fill' | 'select' | 'hover' | 'press' | 'scroll' | 'wait';
  ref?: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  modifiers?: Array<'Alt' | 'Ctrl' | 'Meta' | 'Shift'>;
  dy?: number;
  ms?: number;
};

export const ACT_RUNTIME_JS = `
function targetLabel(step) {
  if (step.ref) return String(step.ref);
  if (step.text) return '"' + clip(String(step.text), 40).replace(/"/g, "'") + '"';
  if (step.selector) return clip(String(step.selector), 40);
  if (typeof step.dy === 'number') return String(step.dy);
  return '';
}

function fire(el, type) {
  var Ctor = window.Event;
  if (type === 'pointerdown' || type === 'pointerup') Ctor = window.PointerEvent || window.MouseEvent || window.Event;
  else if (type !== 'input' && type !== 'change') Ctor = window.MouseEvent || window.Event;
  var ev;
  try {
    ev = new Ctor(type, { bubbles: true, cancelable: true, view: window });
  } catch (err) {
    ev = { type: type, bubbles: true };
  }
  el.dispatchEvent(ev);
}

function isDisabled(el) {
  return !!(el && (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')));
}

function findByText(text) {
  var nodes = document.querySelectorAll(INTERACTIVE_SELECTOR);
  var bestScore = 0;
  var best = [];
  var wanted = String(text || '');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!isVisible(el)) continue;
    var visible = el.textContent ? String(el.textContent) : '';
    var aria = el.getAttribute ? el.getAttribute('aria-label') || '' : '';
    var title = el.getAttribute ? el.getAttribute('title') || el.getAttribute('placeholder') || '' : '';
    var described = describeElement(el);
    var label = aria || (described && described.name) || '';
    var score = scoreTextMatch(visible, label, title, wanted);
    if (score > bestScore) {
      bestScore = score;
      best = [el];
    } else if (score === bestScore && score > 0) {
      best.push(el);
    }
  }
  if (bestScore < MIN_TEXT_SCORE || best.length === 0) return { ok: false, reason: 'no match' };
  if (best.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, el: best[0] };
}

function resolveTarget(step) {
  if (step.ref) {
    if (!/^e\\d{1,4}$/.test(String(step.ref))) return { ok: false, reason: 'bad ref' };
    var byRef = null;
    try {
      byRef = document.querySelector('[data-emcp-ref="' + step.ref + '"]');
    } catch (err) {
      byRef = null;
    }
    if (!byRef) return { ok: false, reason: 'not found' };
    if (!isVisible(byRef)) return { ok: false, reason: 'not visible' };
    return { ok: true, el: byRef };
  }
  if (step.selector) {
    var bySelector = null;
    try {
      bySelector = document.querySelector(step.selector);
    } catch (err2) {
      return { ok: false, reason: 'bad selector' };
    }
    if (!bySelector) return { ok: false, reason: 'not found' };
    if (!isVisible(bySelector)) return { ok: false, reason: 'not visible' };
    return { ok: true, el: bySelector };
  }
  if (step.text) {
    var match = findByText(step.text);
    if (!match.ok) return match;
    if (!isVisible(match.el)) return { ok: false, reason: 'not visible' };
    return { ok: true, el: match.el };
  }
  return { ok: false, reason: 'no target' };
}

function setNativeValue(el, value) {
  var tag = String(el.tagName).toUpperCase();
  var proto = null;
  if (tag === 'TEXTAREA' && window.HTMLTextAreaElement) proto = window.HTMLTextAreaElement.prototype;
  else if (tag === 'SELECT' && window.HTMLSelectElement) proto = window.HTMLSelectElement.prototype;
  else if (window.HTMLInputElement) proto = window.HTMLInputElement.prototype;
  var descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  var setter = descriptor && descriptor.set;
  var previous = el.value;
  if (setter) setter.call(el, value);
  else el.value = value;
  try {
    var tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') tracker.setValue(previous);
  } catch (err) {}
  fire(el, 'input');
  fire(el, 'change');
}

function fillEl(el, value) {
  if (el.isContentEditable) {
    try { if (el.focus) el.focus(); } catch (err) {}
    el.textContent = value;
    fire(el, 'input');
    fire(el, 'change');
    return { ok: true };
  }
  var described = describeElement(el);
  var role = described && described.role;
  if (role !== 'textbox' && role !== 'searchbox' && role !== 'spinbutton') {
    return { ok: false, reason: 'not an input' };
  }
  try { if (el.focus) el.focus(); } catch (err2) {}
  setNativeValue(el, value);
  return { ok: true };
}

function selectOption(el, value) {
  if (String(el.tagName).toUpperCase() !== 'SELECT') return { ok: false, reason: 'not a select' };
  var options = el.options || [];
  var exact = null;
  var partial = [];
  var wanted = String(value);
  var wantedLower = wanted.toLowerCase();
  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    var optValue = opt.value == null ? '' : String(opt.value);
    var optText = opt.textContent != null ? String(opt.textContent) : opt.text || '';
    optText = optText.replace(/\\s+/g, ' ').trim();
    if (optValue === wanted || optText.toLowerCase() === wantedLower) {
      exact = opt;
      break;
    }
    if (optText && wantedLower && optText.toLowerCase().indexOf(wantedLower) !== -1) partial.push(opt);
  }
  var match = exact || (partial.length === 1 ? partial[0] : null);
  if (!match) {
    return { ok: false, reason: partial.length > 1 ? 'ambiguous option' : 'option not found' };
  }
  setNativeValue(el, match.value == null ? '' : String(match.value));
  return { ok: true };
}

function clickEl(el) {
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) {}
  try { if (el.focus) el.focus(); } catch (err2) {}
  if (window.PointerEvent) {
    fire(el, 'pointerdown');
  }
  fire(el, 'mousedown');
  fire(el, 'mouseup');
  if (window.PointerEvent) fire(el, 'pointerup');
  fire(el, 'click');
}

function hoverEl(el) {
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) {}
  fire(el, 'mouseover');
  fire(el, 'mousemove');
  fire(el, 'mouseenter');
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function waitStep(step) {
  var timeout = typeof step.ms === 'number' ? step.ms : 0;
  if (timeout < 0) timeout = 0;
  if (timeout > 2000) timeout = 2000;
  if (step.text) {
    var budget = typeof step.ms === 'number' ? timeout : 1500;
    var start = Date.now();
    var needle = String(step.text);
    while (true) {
      var body = '';
      try {
        body = document.body && document.body.innerText ? String(document.body.innerText) : '';
      } catch (err) {}
      if (body.indexOf(needle) !== -1) return { ok: true, line: 'wait text ok' };
      if (Date.now() - start >= budget) break;
      await sleep(50);
    }
    return { ok: false, line: 'wait text FAIL timeout' };
  }
  if (timeout > 0) {
    await sleep(timeout);
    return { ok: true, line: 'wait ' + timeout + ' ok' };
  }
  return { ok: false, line: 'wait FAIL no ms or text' };
}

async function scrollStep(step) {
  var label = targetLabel(step);
  if (step.ref || step.selector || step.text) {
    var resolved = resolveTarget(step);
    var prefix = label ? 'scroll ' + label : 'scroll';
    if (!resolved.ok) return { ok: false, line: prefix + ' FAIL ' + resolved.reason };
    try {
      resolved.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (err) {
      return { ok: false, line: prefix + ' FAIL ' + clip(err && err.message ? err.message : err, 60) };
    }
    return { ok: true, line: prefix + ' ok' };
  }
  var dy = typeof step.dy === 'number' ? step.dy : 400;
  if (dy > 2000) dy = 2000;
  if (dy < -2000) dy = -2000;
  try {
    if (window.scrollBy) window.scrollBy(0, dy);
  } catch (err2) {
    return { ok: false, line: 'scroll FAIL ' + clip(err2 && err2.message ? err2.message : err2, 60) };
  }
  return { ok: true, line: 'scroll ' + dy + ' ok' };
}

async function runStep(step) {
  var action = step.action;
  var label = targetLabel(step);
  var prefix = label ? action + ' ' + label : action;
  if (action === 'wait') return waitStep(step);
  if (action === 'scroll') return scrollStep(step);
  if (action === 'click' || action === 'hover' || action === 'fill' || action === 'select') {
    var resolved = resolveTarget(step);
    if (!resolved.ok) return { ok: false, line: prefix + ' FAIL ' + resolved.reason };
    var el = resolved.el;
    if ((action === 'click' || action === 'fill' || action === 'select') && isDisabled(el)) {
      return { ok: false, line: prefix + ' FAIL disabled' };
    }
    if (action === 'click') {
      clickEl(el);
      return { ok: true, line: prefix + ' ok' };
    }
    if (action === 'hover') {
      hoverEl(el);
      return { ok: true, line: prefix + ' ok' };
    }
    if (action === 'fill') {
      var filled = fillEl(el, step.value == null ? '' : String(step.value));
      if (!filled.ok) return { ok: false, line: prefix + ' FAIL ' + filled.reason };
      return { ok: true, line: prefix + ' ok' };
    }
    var selected = selectOption(el, step.value == null ? '' : String(step.value));
    if (!selected.ok) return { ok: false, line: prefix + ' FAIL ' + selected.reason };
    return { ok: true, line: prefix + ' ok' };
  }
  return { ok: false, line: (action || 'step') + ' FAIL unsupported' };
}

async function runAct(steps) {
  installErrorHook();
  var list = steps || [];
  var outcomes = [];
  var count = list.length > 8 ? 8 : list.length;
  for (var i = 0; i < count; i++) {
    var step = list[i] || {};
    var outcome;
    try {
      outcome = await runStep(step);
    } catch (err) {
      outcome = { ok: false, line: (step.action || 'step') + ' FAIL ' + clip(err && err.message ? err.message : err, 80) };
    }
    if (!outcome || !outcome.line) outcome = { ok: false, line: (step.action || 'step') + ' FAIL empty' };
    outcomes.push(outcome);
    if (!outcome.ok) break;
  }
  return { outcomes: outcomes };
}
`;

export function actExpression(steps: readonly AgentActStep[]): string {
  return `(async function() {
    ${TEXT_MATCH_HELPERS_JS}
    ${PAGE_AGENT_JS}
    var MIN_TEXT_SCORE = ${CLICK_BY_TEXT_MIN_TEXT_SCORE};
    ${ACT_RUNTIME_JS}
    return JSON.stringify(await runAct(${JSON.stringify(steps)}));
  })()`;
}

export function parseActResult(raw: string): { ok: boolean; lines: string[] } {
  const parsed: unknown = JSON.parse(unwrapEvaluateString(raw).trim());
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { outcomes?: unknown }).outcomes)
  ) {
    throw new Error('act returned no outcomes');
  }
  const outcomes = (parsed as { outcomes: Array<{ ok?: boolean; line?: string }> }).outcomes;
  const lines = outcomes.map((outcome) => clipText(String(outcome.line || ''), 180));
  return { ok: outcomes.length > 0 && outcomes.every((outcome) => outcome.ok !== false), lines };
}
