/**
 * Compact page outline for agents.
 *
 * The renderer stamps `data-emcp-ref` and returns JSON. This module turns that
 * JSON into a short text outline and, when little changed, a diff. The model
 * never sees the JSON.
 */
import type { DevToolsTarget } from './electron-connection';
import { executeInElectron } from './electron-connection';
import { EXECUTE_IN_ELECTRON_RESULT_PREFIX } from '../constants';
import { PAGE_AGENT_JS } from './agent-page';

export const SNAPSHOT_LIMIT_DEFAULT = 60;
export const SNAPSHOT_DIFF_RATIO = 0.4;

export type SnapshotEntry = {
  ref: string;
  role: string;
  name: string;
  level?: number;
  inputType?: string;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
  context?: string;
};

export type SnapshotPayload = {
  title: string;
  url: string;
  entries: SnapshotEntry[];
  omitted: number;
  alerts: string[];
  errorCount: number;
  lastError: string;
  refsReset: boolean;
};

export type SnapshotMemory = {
  entries: SnapshotEntry[];
  alerts: string[];
};

export type SnapshotReport = 'full' | 'diff' | 'auto';

export type RefIdentity = {
  ref: string;
  role: string;
  name: string;
};

const COMMAND_EXECUTED_PREFIX = '✅ Command executed: ';

const memoryByTarget = new Map<string, SnapshotMemory>();

export const SNAPSHOT_RUNTIME_JS = `
function takeSnapshot(previous, limit) {
  installErrorHook();
  var cap = limit;
  if (!(cap > 0)) cap = 60;
  if (cap > 200) cap = 200;
  var nodes = document.querySelectorAll(SNAPSHOT_SELECTOR);
  var items = [];
  var lastHeading = '';
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!isVisible(el)) continue;
    var described = describeElement(el);
    if (!described) continue;
    if (described.role === 'heading' && !described.name) continue;
    if (described.role === 'heading' && described.name) lastHeading = described.name;
    items.push({
      el: el,
      role: described.role,
      name: described.name,
      level: described.level,
      inputType: described.inputType,
      checked: described.checked,
      disabled: described.disabled,
      value: described.value,
      rank: described.rank,
      domIndex: items.length,
      contextHeading: lastHeading
    });
  }
  var kept = items;
  var omitted = 0;
  if (items.length > cap) {
    var ranked = items.slice().sort(function(a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.domIndex - b.domIndex;
    });
    kept = ranked.slice(0, cap);
    kept.sort(function(a, b) { return a.domIndex - b.domIndex; });
    omitted = items.length - kept.length;
  }
  var counts = {};
  for (var c = 0; c < kept.length; c++) {
    var countKey = kept[c].role + '\\n' + kept[c].name;
    counts[countKey] = (counts[countKey] || 0) + 1;
  }
  var seenDup = {};
  for (var d = 0; d < kept.length; d++) {
    var dupKey = kept[d].role + '\\n' + kept[d].name;
    if (counts[dupKey] > 1 && kept[d].role !== 'heading') {
      seenDup[dupKey] = (seenDup[dupKey] || 0) + 1;
      var heading = kept[d].contextHeading && kept[d].contextHeading !== kept[d].name
        ? kept[d].contextHeading
        : '';
      kept[d].context = heading ? heading + ' #' + seenDup[dupKey] : '#' + seenDup[dupKey];
    }
  }
  var assigned = assignRefs(kept, previous || []);
  for (var r = 0; r < kept.length; r++) kept[r].ref = assigned.refs[r];
  stampRefs(kept);
  var entries = [];
  for (var e = 0; e < kept.length; e++) {
    var item = kept[e];
    var entry = { ref: item.ref, role: item.role, name: item.name };
    if (item.level) entry.level = item.level;
    if (item.inputType) entry.inputType = item.inputType;
    if (item.checked === true || item.checked === false) entry.checked = item.checked;
    if (item.disabled) entry.disabled = true;
    if (item.value !== null && item.value !== undefined) entry.value = item.value;
    if (item.context) entry.context = item.context;
    entries.push(entry);
  }
  var errors = drainErrors();
  var href = '';
  try {
    href = window.location && window.location.href ? String(window.location.href) : '';
  } catch (err) {}
  var title = '';
  try {
    title = document.title ? clip(String(document.title), 80) : '';
  } catch (err2) {}
  return {
    title: title,
    url: href,
    entries: entries,
    omitted: omitted,
    alerts: readAlerts(),
    errorCount: errors.count,
    lastError: errors.last,
    refsReset: assigned.refsReset ? true : false
  };
}

function stampRefs(kept) {
  var liveRef = {};
  var liveEl = {};
  for (var i = 0; i < kept.length; i++) {
    liveRef[kept[i].ref] = true;
    liveEl[kept[i].ref] = kept[i].el;
  }
  var existing = document.querySelectorAll('[data-emcp-ref]');
  for (var s = 0; s < existing.length; s++) {
    var current = existing[s].getAttribute('data-emcp-ref');
    if (!liveRef[current] || liveEl[current] !== existing[s]) {
      existing[s].removeAttribute('data-emcp-ref');
    }
  }
  for (var k = 0; k < kept.length; k++) {
    kept[k].el.setAttribute('data-emcp-ref', kept[k].ref);
  }
}
`;

export function clipText(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  if (max <= 3) return collapsed.slice(0, max);
  return `${collapsed.slice(0, max - 3)}...`;
}

export function clampSnapshotLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SNAPSHOT_LIMIT_DEFAULT;
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

export function unwrapEvaluateString(raw: string): string {
  if (raw.startsWith(COMMAND_EXECUTED_PREFIX)) return raw.slice(COMMAND_EXECUTED_PREFIX.length);
  if (raw.startsWith(EXECUTE_IN_ELECTRON_RESULT_PREFIX)) {
    return raw.slice(EXECUTE_IN_ELECTRON_RESULT_PREFIX.length);
  }
  return raw;
}

export function identities(entries: readonly SnapshotEntry[]): RefIdentity[] {
  return entries.map((entry) => ({ ref: entry.ref, role: entry.role, name: entry.name }));
}

export function snapshotExpression(previous: readonly RefIdentity[], limit: number): string {
  const cap = clampSnapshotLimit(limit);
  return `(function() {
    ${PAGE_AGENT_JS}
    ${SNAPSHOT_RUNTIME_JS}
    return JSON.stringify(takeSnapshot(${JSON.stringify(previous)}, ${cap}));
  })()`;
}

export function shortLocation(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      const base = parsed.pathname.split(/[/\\]/).filter(Boolean).pop() || 'file';
      return `${base}${parsed.search}${parsed.hash}`;
    }
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path || parsed.host || url;
  } catch {
    return clipText(url, 80);
  }
}

export function formatHeader(title: string, url: string): string {
  const where = shortLocation(url);
  const name = clipText(title, 80);
  if (name && where) return `${name} · ${where}`;
  return name || where || 'page';
}

function cleanName(name: string): string {
  return clipText(name, 60).replace(/"/g, "'");
}

function cleanRole(role: string): string {
  const cleaned = role.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.slice(0, 24) || 'generic';
}

function showValue(value: string | undefined): string {
  if (value === '(hidden)') return '(hidden)';
  return JSON.stringify(value ?? '');
}

export function formatEntry(entry: SnapshotEntry): string {
  let line = `${entry.role} "${cleanName(entry.name)}" [ref=${entry.ref}]`;
  if (entry.level) line += ` [level=${entry.level}]`;
  if (entry.inputType) line += ` [type=${entry.inputType}]`;
  if (entry.disabled) line += ' disabled';
  if (entry.checked === true) line += ' checked';
  else if (entry.checked === false) line += ' unchecked';
  if (entry.value !== undefined) line += `: ${showValue(entry.value)}`;
  if (entry.context) line += ` in "${cleanName(entry.context)}"`;
  return line;
}

export type SnapshotDiff = {
  added: SnapshotEntry[];
  removed: SnapshotEntry[];
  changed: Array<{ previous: SnapshotEntry; next: SnapshotEntry }>;
  unchanged: number;
};

function sameShape(left: SnapshotEntry, right: SnapshotEntry): boolean {
  return (
    left.role === right.role &&
    left.name === right.name &&
    left.value === right.value &&
    left.disabled === right.disabled &&
    left.checked === right.checked &&
    left.context === right.context &&
    left.level === right.level &&
    left.inputType === right.inputType
  );
}

export function diffSnapshot(
  previous: readonly SnapshotEntry[],
  next: readonly SnapshotEntry[],
): SnapshotDiff {
  const previousByRef = new Map(previous.map((entry) => [entry.ref, entry]));
  const nextByRef = new Map(next.map((entry) => [entry.ref, entry]));
  const added: SnapshotEntry[] = [];
  const removed: SnapshotEntry[] = [];
  const changed: Array<{ previous: SnapshotEntry; next: SnapshotEntry }> = [];
  let unchanged = 0;
  for (const entry of next) {
    const prior = previousByRef.get(entry.ref);
    if (!prior) added.push(entry);
    else if (!sameShape(prior, entry)) changed.push({ previous: prior, next: entry });
    else unchanged += 1;
  }
  for (const entry of previous) {
    if (!nextByRef.has(entry.ref)) removed.push(entry);
  }
  return { added, removed, changed, unchanged };
}

function formatChange(previous: SnapshotEntry, next: SnapshotEntry): string {
  if (
    previous.role === next.role &&
    previous.name === next.name &&
    previous.value !== next.value &&
    previous.disabled === next.disabled &&
    previous.checked === next.checked
  ) {
    return `changed ${next.role} "${cleanName(next.name)}" [ref=${next.ref}]: ${showValue(previous.value)} → ${showValue(next.value)}`;
  }
  return `changed ${formatEntry(next)} (was ${formatEntry(previous)})`;
}

function footer(
  payload: SnapshotPayload,
  alerts: readonly string[],
  includeOmitted: boolean,
): string[] {
  const lines: string[] = [];
  if (includeOmitted && payload.omitted > 0) {
    lines.push(`... ${payload.omitted} more controls (pass a higher limit)`);
  }
  for (const alert of alerts) lines.push(`alert: ${alert}`);
  if (payload.errorCount > 0 && payload.lastError) {
    const count = payload.errorCount > 1 ? ` (${payload.errorCount})` : '';
    lines.push(`error${count}: ${payload.lastError}`);
  }
  return lines;
}

function fullOutline(
  payload: SnapshotPayload,
  alerts: readonly string[],
  refsReset: boolean,
): string {
  const lines = [formatHeader(payload.title, payload.url)];
  if (refsReset) lines.unshift('refs reset');
  if (payload.entries.length === 0) lines.push('no controls');
  for (const entry of payload.entries) lines.push(`- ${formatEntry(entry)}`);
  lines.push(...footer(payload, alerts, true));
  return lines.join('\n');
}

export function renderSnapshot(
  payload: SnapshotPayload,
  previous: SnapshotMemory,
  report: SnapshotReport,
): string {
  const priorEntries = previous.entries;
  const diff = diffSnapshot(priorEntries, payload.entries);
  const structural = diff.added.length + diff.removed.length;
  const structuralRatio = structural / Math.max(priorEntries.length, payload.entries.length, 1);
  const changeLines = structural + diff.changed.length;
  // Value edits stay a diff even on a short page. Added and removed controls
  // past the ratio mean the page turned over, and a long diff costs more
  // than printing the outline once.
  const forceFull =
    report === 'full' ||
    payload.refsReset ||
    priorEntries.length === 0 ||
    (report === 'auto' && (structuralRatio > SNAPSHOT_DIFF_RATIO || changeLines > 12));

  if (forceFull) {
    return fullOutline(payload, payload.alerts, payload.refsReset && priorEntries.length > 0);
  }

  const newAlerts = payload.alerts.filter((alert) => !previous.alerts.includes(alert));
  const lines = [formatHeader(payload.title, payload.url)];
  for (const entry of diff.removed) lines.push(`removed ${formatEntry(entry)}`);
  for (const entry of diff.added) lines.push(`added ${formatEntry(entry)}`);
  for (const change of diff.changed) lines.push(formatChange(change.previous, change.next));
  if (diff.unchanged > 0) lines.push(`unchanged ${diff.unchanged}`);
  lines.push(...footer(payload, newAlerts, false));
  return lines.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sanitizeEntry(value: unknown): SnapshotEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = typeof record.ref === 'string' ? record.ref : '';
  if (!/^e\d{1,4}$/.test(ref)) return null;
  const entry: SnapshotEntry = {
    ref,
    role: cleanRole(typeof record.role === 'string' ? record.role : ''),
    name: clipText(typeof record.name === 'string' ? record.name : '', 60),
  };
  if (typeof record.level === 'number' && record.level >= 1 && record.level <= 9) {
    entry.level = Math.floor(record.level);
  }
  if (typeof record.inputType === 'string' && /^[a-z0-9-]{1,20}$/.test(record.inputType)) {
    entry.inputType = record.inputType;
  }
  if (typeof record.checked === 'boolean') entry.checked = record.checked;
  if (record.disabled === true) entry.disabled = true;
  if (typeof record.value === 'string') entry.value = clipText(record.value, 40);
  if (typeof record.context === 'string' && record.context.trim()) {
    entry.context = clipText(record.context, 80);
  }
  return entry;
}

export function parseSnapshotPayload(raw: string): SnapshotPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('snapshot returned non-JSON');
  }
  const record = asRecord(parsed);
  if (!record || !Array.isArray(record.entries)) throw new Error('snapshot returned no entries');

  const seen = new Set<string>();
  const entries: SnapshotEntry[] = [];
  for (const item of record.entries) {
    const entry = sanitizeEntry(item);
    if (!entry || seen.has(entry.ref)) continue;
    seen.add(entry.ref);
    entries.push(entry);
    if (entries.length >= 200) break;
  }

  const alerts = Array.isArray(record.alerts)
    ? record.alerts
        .filter((alert): alert is string => typeof alert === 'string')
        .map((alert) => clipText(alert, 120))
        .filter(Boolean)
        .slice(0, 2)
    : [];

  const omitted =
    typeof record.omitted === 'number' && record.omitted > 0 ? Math.floor(record.omitted) : 0;
  const errorCount =
    typeof record.errorCount === 'number' && record.errorCount > 0
      ? Math.floor(record.errorCount)
      : 0;

  return {
    title: clipText(typeof record.title === 'string' ? record.title : '', 80),
    url: clipText(typeof record.url === 'string' ? record.url : '', 300),
    entries,
    omitted,
    alerts,
    errorCount,
    lastError: clipText(typeof record.lastError === 'string' ? record.lastError : '', 160),
    refsReset: record.refsReset === true,
  };
}

function emptyMemory(): SnapshotMemory {
  return { entries: [], alerts: [] };
}

function memoryKey(target: DevToolsTarget): string {
  return target.id || target.webSocketDebuggerUrl || target.url;
}

export function recallSnapshot(targetId: string): SnapshotMemory {
  const found = memoryByTarget.get(targetId);
  if (!found) return emptyMemory();
  return {
    entries: found.entries.map((entry) => ({ ...entry })),
    alerts: [...found.alerts],
  };
}

export function rememberSnapshot(targetId: string, memory: SnapshotMemory): void {
  memoryByTarget.set(targetId, {
    entries: memory.entries.map((entry) => ({ ...entry })),
    alerts: [...memory.alerts],
  });
}

export function resetAgentSnapshotMemory(): void {
  memoryByTarget.clear();
}

function safeAgentError(message: string): string {
  return clipText(
    message
      .replace(/[A-Z]:\\[^\s"']+/gi, '[path]')
      .replace(/\/[a-z][\w/]+\.(ts|js|json)/gi, '[path]')
      .replace(/ws:\/\/[^\s"']+/g, '[ws]')
      .replace(/localhost:\d+/g, '[host]'),
    160,
  );
}

export async function publishSnapshot(
  target: DevToolsTarget,
  limit: number,
  report: SnapshotReport,
): Promise<string> {
  const key = memoryKey(target);
  const previous = recallSnapshot(key);
  try {
    const raw = await executeInElectron(
      snapshotExpression(identities(previous.entries), limit),
      target,
    );
    const payload = parseSnapshotPayload(unwrapEvaluateString(raw));
    const text = renderSnapshot(payload, previous, report);
    rememberSnapshot(key, { entries: payload.entries, alerts: payload.alerts });
    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `snapshot FAIL ${safeAgentError(message)}`;
  }
}
