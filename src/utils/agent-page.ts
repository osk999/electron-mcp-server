/**
 * DOM helpers shared by `electron_snapshot` and `electron_act`.
 *
 * The string is evaluated inside the Electron renderer. It is also loaded
 * with `new Function` in unit tests, so this is the only copy of the walker.
 */
export const PAGE_AGENT_JS = `
var INTERACTIVE_SELECTOR = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="searchbox"],[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';
var HEADING_SELECTOR = 'h1,h2,h3,[role="heading"]';
var SNAPSHOT_SELECTOR = INTERACTIVE_SELECTOR + ',' + HEADING_SELECTOR;
var ALERT_SELECTOR = '[role="alert"],[role="status"]';

function clip(value, max) {
  var text = value == null ? '' : String(value);
  text = text.replace(/\\s+/g, ' ').trim();
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return text.slice(0, max - 3) + '...';
}

function usableId(id) {
  if (!id || !/^[A-Za-z][\\w-]{0,31}$/.test(id)) return '';
  return id;
}

function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  var node = el;
  while (node && node !== document) {
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
    node = node.parentElement;
  }
  var style = { display: 'block', visibility: 'visible', opacity: '1' };
  try {
    if (window.getComputedStyle) style = window.getComputedStyle(el) || style;
  } catch (err) {}
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  var rect = { width: 1, height: 1 };
  try {
    if (el.getBoundingClientRect) rect = el.getBoundingClientRect() || rect;
  } catch (err2) {}
  if (!rect || rect.width < 1 || rect.height < 1) return false;
  return true;
}

function accessibleName(el) {
  if (!el) return '';
  var aria = el.getAttribute ? el.getAttribute('aria-label') || '' : '';
  aria = clip(aria, 60);
  if (aria) return aria;

  var labelledby = el.getAttribute ? el.getAttribute('aria-labelledby') : '';
  if (labelledby) {
    var ids = String(labelledby).split(/\\s+/);
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var node = document.getElementById(ids[i]);
      if (node && node.textContent) parts.push(String(node.textContent));
    }
    var joined = clip(parts.join(' '), 60);
    if (joined) return joined;
  }

  if (el.id) {
    var escaped = el.id;
    try {
      if (window.CSS && window.CSS.escape) escaped = window.CSS.escape(el.id);
    } catch (err) {}
    var forLabel = null;
    try {
      forLabel = document.querySelector('label[for="' + escaped + '"]');
    } catch (err2) {
      forLabel = null;
    }
    if (forLabel && forLabel.textContent) {
      var forText = clip(String(forLabel.textContent), 60);
      if (forText) return forText;
    }
  }

  var parent = el.parentElement;
  var depth = 0;
  while (parent && depth < 6) {
    if (String(parent.tagName).toUpperCase() === 'LABEL' && parent.textContent) {
      var wrapped = clip(String(parent.textContent), 60);
      if (wrapped) return wrapped;
      break;
    }
    parent = parent.parentElement;
    depth = depth + 1;
  }

  var placeholder = el.getAttribute ? el.getAttribute('placeholder') || '' : '';
  placeholder = clip(placeholder, 60);
  if (placeholder) return placeholder;

  var alt = el.getAttribute ? el.getAttribute('alt') || '' : '';
  alt = clip(alt, 60);
  if (alt) return alt;

  if (el.textContent) {
    var text = clip(String(el.textContent), 60);
    if (text) return text;
  }

  var title = el.getAttribute ? el.getAttribute('title') || '' : '';
  title = clip(title, 60);
  if (title) return title;

  var idName = usableId(el.id || '');
  if (idName) return '#' + idName;
  return '';
}

function rankOf(role) {
  if (
    role === 'textbox' || role === 'searchbox' || role === 'checkbox' || role === 'radio' ||
    role === 'combobox' || role === 'slider' || role === 'spinbutton' || role === 'switch' ||
    role === 'file'
  ) {
    return 0;
  }
  if (role === 'button') return 1;
  if (role === 'heading') return 3;
  return 2;
}

function readChecked(el, role) {
  if (
    role !== 'checkbox' && role !== 'radio' && role !== 'switch' &&
    role !== 'menuitemcheckbox' && role !== 'menuitemradio'
  ) {
    return null;
  }
  var type = el.type ? String(el.type).toLowerCase() : '';
  if (typeof el.checked === 'boolean' && (type === 'checkbox' || type === 'radio')) return el.checked;
  var aria = el.getAttribute ? el.getAttribute('aria-checked') : null;
  if (aria === 'true') return true;
  if (aria === 'false' || aria === 'mixed') return false;
  if (typeof el.checked === 'boolean') return el.checked;
  return false;
}

function readValue(el, role, inputType) {
  if (
    role !== 'textbox' && role !== 'searchbox' && role !== 'combobox' &&
    role !== 'slider' && role !== 'spinbutton'
  ) {
    return null;
  }
  if (inputType === 'password') return el.value ? '(hidden)' : '';
  if (String(el.tagName).toUpperCase() === 'SELECT') {
    var idx = el.selectedIndex;
    if (typeof idx === 'number' && idx >= 0 && el.options && el.options[idx]) {
      var opt = el.options[idx];
      var optText = opt.textContent != null ? String(opt.textContent) : opt.text || '';
      optText = clip(optText, 40);
      if (optText) return optText;
    }
  }
  if (el.value == null) return '';
  return clip(String(el.value), 40);
}

function describeElement(el) {
  if (!el || !el.tagName) return null;
  var explicit = el.getAttribute ? String(el.getAttribute('role') || '').trim().toLowerCase() : '';
  var tag = String(el.tagName).toUpperCase();
  var type = el.type ? String(el.type).toLowerCase() : '';
  if (tag === 'INPUT' && type === 'hidden') return null;
  if (explicit === 'presentation' || explicit === 'none' || explicit === 'generic' || explicit === 'option') {
    return null;
  }
  if (explicit && !/^[a-z0-9]+$/.test(explicit)) return null;

  var role = '';
  var level = 0;
  var inputType = '';
  if (explicit === 'heading') {
    role = 'heading';
    var ariaLevel = parseInt(el.getAttribute('aria-level') || '2', 10);
    level = ariaLevel > 0 && ariaLevel < 10 ? ariaLevel : 2;
  } else if (explicit) {
    role = explicit;
  } else if (tag === 'A') {
    role = 'link';
  } else if (tag === 'BUTTON' || tag === 'SUMMARY') {
    role = 'button';
  } else if (tag === 'SELECT') {
    role = 'combobox';
  } else if (tag === 'TEXTAREA') {
    role = 'textbox';
  } else if (tag === 'INPUT') {
    if (type === 'checkbox') role = 'checkbox';
    else if (type === 'radio') role = 'radio';
    else if (type === 'range') role = 'slider';
    else if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') role = 'button';
    else if (type === 'file') role = 'file';
    else if (type === 'search') role = 'searchbox';
    else {
      role = 'textbox';
      if (type === 'password') inputType = 'password';
      else if (type && type !== 'text') inputType = type;
    }
  } else if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
    role = 'heading';
    level = tag === 'H1' ? 1 : tag === 'H2' ? 2 : 3;
  } else if (el.isContentEditable) {
    role = 'textbox';
  } else {
    return null;
  }

  if (!role || role.length > 24) return null;
  var name = accessibleName(el);
  if (!name && tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) {
    name = el.value ? clip(String(el.value), 60) : type;
  }
  name = String(name || '').replace(/[:：]\\s*$/, '');

  return {
    role: role,
    name: name,
    level: level,
    inputType: inputType,
    checked: readChecked(el, role),
    disabled: !!(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')),
    value: readValue(el, role, inputType),
    rank: rankOf(role)
  };
}

function assignRefs(items, previous) {
  var buckets = {};
  var maxN = 0;
  var prev = previous || [];
  for (var i = 0; i < prev.length; i++) {
    var prior = prev[i];
    if (!prior || typeof prior.ref !== 'string') continue;
    var n = parseInt(prior.ref.slice(1), 10);
    if (!(n > 0)) continue;
    if (n > maxN) maxN = n;
    var key = String(prior.role) + '\\n' + String(prior.name);
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(prior.ref);
  }
  var refsReset = maxN > 400;
  var nextN = refsReset ? 1 : maxN + 1;
  var used = {};
  var refs = [];
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var itemKey = String(item.role) + '\\n' + String(item.name);
    var ref = '';
    var queue = !refsReset && buckets[itemKey] ? buckets[itemKey] : null;
    if (queue) {
      while (queue.length && used[queue[0]]) queue.shift();
      if (queue.length) ref = queue.shift();
    }
    if (!ref) {
      while (used['e' + nextN]) nextN = nextN + 1;
      ref = 'e' + nextN;
      nextN = nextN + 1;
    }
    used[ref] = true;
    refs.push(ref);
  }
  return { refs: refs, refsReset: refsReset };
}

function installErrorHook() {
  if (!window || window.__emcpHooked) return;
  window.__emcpHooked = true;
  if (!window.__emcpErrors) window.__emcpErrors = [];
  if (!window.addEventListener) return;
  function push(msg) {
    var text = clip(msg, 160);
    if (!text) return;
    var list = window.__emcpErrors;
    if (list.length && list[list.length - 1] === text) return;
    list.push(text);
    if (list.length > 10) list.shift();
  }
  window.addEventListener('error', function(ev) {
    push(ev && ev.message ? ev.message : 'error');
  });
  window.addEventListener('unhandledrejection', function(ev) {
    var reason = ev && ev.reason;
    push(reason && reason.message ? reason.message : reason);
  });
}

function drainErrors() {
  var list = (window && window.__emcpErrors) || [];
  var count = list.length;
  var last = count ? clip(String(list[count - 1]), 160) : '';
  if (window) window.__emcpErrors = [];
  return { count: count, last: last };
}

function readAlerts() {
  var nodes = document.querySelectorAll(ALERT_SELECTOR);
  var out = [];
  for (var i = 0; i < nodes.length && out.length < 2; i++) {
    if (!isVisible(nodes[i])) continue;
    var text = clip(nodes[i].textContent || '', 120);
    if (text) out.push(text);
  }
  return out;
}
`;
