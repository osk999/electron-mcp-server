import { describe, expect, it } from 'vitest';
import { CLICK_BY_TEXT_MIN_TEXT_SCORE } from '../../src/constants';
import { commandsByName } from '../../src/commands';
import { ACT_RUNTIME_JS } from '../../src/utils/agent-act';
import { PAGE_AGENT_JS } from '../../src/utils/agent-page';
import { TEXT_MATCH_HELPERS_JS } from '../../src/utils/text-matching';
import {
  SNAPSHOT_RUNTIME_JS,
  diffSnapshot,
  formatEntry,
  parseSnapshotPayload,
  renderSnapshot,
  shortLocation,
  unwrapEvaluateString,
  type SnapshotEntry,
  type SnapshotPayload,
} from '../../src/utils/agent-snapshot';

type Attrs = Record<string, string>;

class FakeElement {
  tagName: string;
  type = '';
  id = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  textContent = '';
  className = '';
  isContentEditable = false;
  parentElement: FakeElement | null = null;
  attrs: Attrs;
  options: Array<{ value: string; textContent: string }> = [];
  selectedIndex = -1;
  events: string[] = [];
  scrolled = false;

  constructor(tag: string, text = '', attrs: Attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.attrs = { ...attrs };
    if (attrs.id) this.id = attrs.id;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
    if (name === 'id') this.id = String(value);
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 12, height: 12 };
  }

  focus(): void {}

  scrollIntoView(): void {
    this.scrolled = true;
  }

  dispatchEvent(event: { type?: string }): boolean {
    if (event?.type) this.events.push(event.type);
    return true;
  }
}

function createPage(
  elements: FakeElement[],
  title = 'Inbox',
  href = 'http://127.0.0.1:3000/#/inbox',
) {
  const window = {
    location: { href },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener: () => undefined,
    scrollBy: (_x: number, y: number) => {
      window.scrolledBy = y;
    },
    scrolledBy: 0,
    __emcpHooked: false,
    __emcpErrors: [] as string[],
    CSS: { escape: (value: string) => value },
  };
  const document = {
    title,
    body: { innerText: '' },
    getElementById(id: string) {
      return elements.find((element) => element.id === id) ?? null;
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      const ref = /data-emcp-ref="(e\d+)"/.exec(selector);
      if (ref) return elements.filter((element) => element.attrs['data-emcp-ref'] === ref[1]);
      if (selector.includes('data-emcp-ref')) {
        return elements.filter((element) => Boolean(element.attrs['data-emcp-ref']));
      }
      if (selector.includes('role="alert"')) {
        return elements.filter(
          (element) => element.attrs.role === 'alert' || element.attrs.role === 'status',
        );
      }
      if (selector.includes('label[for')) {
        const id = /for="([^"]*)"/.exec(selector)?.[1];
        return elements.filter(
          (element) => element.tagName === 'LABEL' && element.attrs.for === id,
        );
      }
      if (selector.includes('h1')) {
        return elements.filter(
          (element) =>
            element.tagName !== 'LABEL' &&
            element.attrs.role !== 'alert' &&
            element.attrs.role !== 'status',
        );
      }
      const tags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);
      const roles = new Set([
        'button',
        'link',
        'textbox',
        'checkbox',
        'radio',
        'combobox',
        'tab',
        'menuitem',
        'switch',
        'slider',
        'spinbutton',
        'searchbox',
      ]);
      return elements.filter((element) => {
        if (
          element.tagName === 'LABEL' ||
          (element.tagName === 'INPUT' && element.type === 'hidden')
        ) {
          return false;
        }
        if (tags.has(element.tagName) || element.isContentEditable) return true;
        return roles.has(element.attrs.role || '');
      });
    },
  };
  return { document, window, elements };
}

function evalWithPage(source: string, page: ReturnType<typeof createPage>): unknown {
  const fn = new Function('document', 'window', source);
  return fn(page.document, page.window);
}

function takeSnapshot(page: ReturnType<typeof createPage>, previous: unknown[] = [], limit = 60) {
  return evalWithPage(
    `${PAGE_AGENT_JS}\n${SNAPSHOT_RUNTIME_JS}\nreturn takeSnapshot(${JSON.stringify(previous)}, ${limit});`,
    page,
  ) as {
    title: string;
    url: string;
    entries: SnapshotEntry[];
    omitted: number;
    alerts: string[];
    errorCount: number;
    lastError: string;
    refsReset: boolean;
  };
}

function assignRefs(
  items: Array<{ role: string; name: string }>,
  previous: Array<{ ref: string; role: string; name: string }>,
): { refs: string[]; refsReset: boolean } {
  const fn = new Function(
    `${PAGE_AGENT_JS}\nreturn assignRefs(${JSON.stringify(items)}, ${JSON.stringify(previous)});`,
  );
  return fn();
}

async function runAct(
  page: ReturnType<typeof createPage>,
  steps: unknown[],
): Promise<{ outcomes: Array<{ ok: boolean; line: string }> }> {
  const fn = new Function(
    'document',
    'window',
    `${TEXT_MATCH_HELPERS_JS}\n${PAGE_AGENT_JS}\nvar MIN_TEXT_SCORE = ${CLICK_BY_TEXT_MIN_TEXT_SCORE};\n${ACT_RUNTIME_JS}\nreturn runAct(${JSON.stringify(steps)});`,
  );
  return fn(page.document, page.window);
}

function payload(entries: SnapshotEntry[], extra: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    title: 'Inbox',
    url: 'http://127.0.0.1:3000/#/inbox',
    entries,
    omitted: 0,
    alerts: [],
    errorCount: 0,
    lastError: '',
    refsReset: false,
    ...extra,
  };
}

describe('agent outline', () => {
  it('reuses refs when a new control is inserted above', () => {
    const first = assignRefs(
      [
        { role: 'button', name: 'Save' },
        { role: 'textbox', name: 'Email' },
      ],
      [],
    );
    expect(first.refs).toEqual(['e1', 'e2']);
    expect(first.refsReset).toBe(false);

    const second = assignRefs(
      [
        { role: 'button', name: 'Undo' },
        { role: 'button', name: 'Save' },
        { role: 'textbox', name: 'Email' },
      ],
      [
        { ref: 'e1', role: 'button', name: 'Save' },
        { ref: 'e2', role: 'textbox', name: 'Email' },
      ],
    );
    expect(second.refs).toEqual(['e3', 'e1', 'e2']);
  });

  it('resets refs after they grow past 400', () => {
    const reset = assignRefs(
      [{ role: 'button', name: 'Save' }],
      [{ ref: 'e401', role: 'button', name: 'Save' }],
    );
    expect(reset.refsReset).toBe(true);
    expect(reset.refs).toEqual(['e1']);
  });

  it('names controls without utility classes and hides password values', () => {
    const heading = new FakeElement('H1', 'Inbox');
    const save = new FakeElement('BUTTON', 'Save');
    save.className = 'sand-1n2onr6 sand-3nfvp2 sand-6s0dn4';
    const emailLabel = new FakeElement('LABEL', 'Email:', { for: 'email' });
    const email = new FakeElement('INPUT', '', { id: 'email' });
    email.id = 'email';
    email.type = 'text';
    const password = new FakeElement('INPUT', '', { 'aria-label': 'Password' });
    password.type = 'password';
    password.value = 's3cret';
    const remember = new FakeElement('INPUT', '', { 'aria-label': 'Remember' });
    remember.type = 'checkbox';
    remember.checked = false;
    const alert = new FakeElement('DIV', 'Saved', { role: 'alert' });
    const page = createPage([heading, save, emailLabel, email, password, remember, alert]);
    page.window.__emcpErrors = ['Cannot read properties of undefined'];

    const snapshot = takeSnapshot(page);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('sand-1n2onr6');
    expect(encoded).not.toContain('s3cret');
    expect(snapshot.entries.map((entry) => `${entry.role}:${entry.name}:${entry.ref}`)).toEqual([
      'heading:Inbox:e1',
      'button:Save:e2',
      'textbox:Email:e3',
      'textbox:Password:e4',
      'checkbox:Remember:e5',
    ]);
    expect(snapshot.entries[3].value).toBe('(hidden)');
    expect(snapshot.entries[3].inputType).toBe('password');
    expect(snapshot.entries[4].checked).toBe(false);
    expect(snapshot.alerts).toEqual(['Saved']);
    expect(snapshot.lastError).toContain('Cannot read properties');
    expect(save.getAttribute('data-emcp-ref')).toBe('e2');

    const again = takeSnapshot(page);
    expect(again.errorCount).toBe(0);
    expect(again.lastError).toBe('');
  });

  it('keeps form fields when the outline limit drops headings', () => {
    const button = new FakeElement('BUTTON', 'Save');
    const headings = Array.from(
      { length: 12 },
      (_item, index) => new FakeElement('H2', `Section ${index}`),
    );
    const page = createPage([button, ...headings]);
    const snapshot = takeSnapshot(page, [], 10);
    expect(snapshot.entries).toHaveLength(10);
    expect(snapshot.entries.some((entry) => entry.name === 'Save')).toBe(true);
    expect(snapshot.omitted).toBe(3);
  });

  it('disambiguates duplicate labels with the nearest heading', () => {
    const heading = new FakeElement('H1', 'Inbox');
    const first = new FakeElement('BUTTON', 'Delete');
    const second = new FakeElement('BUTTON', 'Delete');
    const page = createPage([heading, first, second]);
    const snapshot = takeSnapshot(page);
    expect(snapshot.entries[1].context).toBe('Inbox #1');
    expect(snapshot.entries[2].context).toBe('Inbox #2');
    expect(formatEntry(snapshot.entries[1])).toContain('in "Inbox #1"');
  });

  it('renders a diff for a value change and a full outline when the page turns over', () => {
    const save: SnapshotEntry = { ref: 'e1', role: 'button', name: 'Save' };
    const email = (value: string): SnapshotEntry => ({
      ref: 'e2',
      role: 'textbox',
      name: 'Email',
      value,
    });
    const diff = renderSnapshot(
      payload([save, email('a@b.co')]),
      { entries: [save, email('')], alerts: [] },
      'auto',
    );
    expect(diff).toContain('Inbox · /#/inbox');
    expect(diff).toContain('changed textbox "Email" [ref=e2]: "" → "a@b.co"');
    expect(diff).toContain('unchanged 1');
    expect(diff).not.toMatch(/^- /m);

    const previous = ['e1', 'e2', 'e3'].map((ref) => ({ ref, role: 'button', name: ref }));
    const next = ['e4', 'e5', 'e6'].map((ref) => ({ ref, role: 'button', name: ref }));
    expect(renderSnapshot(payload(next), { entries: previous, alerts: [] }, 'auto')).toContain(
      '- button "e4"',
    );
    expect(renderSnapshot(payload(next), { entries: previous, alerts: [] }, 'diff')).toContain(
      'removed button "e1"',
    );
    expect(shortLocation('file:///C:/app/index.html#/inbox')).toBe('index.html#/inbox');
  });

  it('clicks, fills, and stops after a miss without echoing a password', async () => {
    const save = new FakeElement('BUTTON', 'Save');
    save.setAttribute('data-emcp-ref', 'e1');
    const email = new FakeElement('INPUT', '', { 'aria-label': 'Email' });
    email.type = 'text';
    email.setAttribute('data-emcp-ref', 'e2');
    const other = new FakeElement('BUTTON', 'Save');
    const page = createPage([save, email, other]);

    const clicked = await runAct(page, [{ action: 'click', ref: 'e1' }]);
    expect(clicked.outcomes).toEqual([{ ok: true, line: 'click e1 ok' }]);
    expect(save.events).toContain('click');

    const filled = await runAct(page, [{ action: 'fill', ref: 'e2', value: 'ada@example.com' }]);
    expect(filled.outcomes[0].ok).toBe(true);
    expect(email.value).toBe('ada@example.com');
    expect(filled.outcomes[0].line).not.toContain('ada@example.com');

    const ambiguous = await runAct(page, [{ action: 'click', text: 'Save' }]);
    expect(ambiguous.outcomes[0].line).toContain('FAIL ambiguous');

    const stopped = await runAct(page, [
      { action: 'click', ref: 'e9' },
      { action: 'fill', ref: 'e2', value: 'nope' },
    ]);
    expect(stopped.outcomes).toHaveLength(1);
    expect(stopped.outcomes[0].line).toContain('FAIL not found');
    expect(email.value).toBe('ada@example.com');
  });

  it('selects an option, scrolls, and waits for text that is already there', async () => {
    const select = new FakeElement('SELECT', '', { 'aria-label': 'Theme' });
    select.options = [
      { value: 'light', textContent: 'Light' },
      { value: 'dark', textContent: 'Dark' },
    ];
    select.selectedIndex = 0;
    select.setAttribute('data-emcp-ref', 'e4');
    const page = createPage([select]);
    page.document.body.innerText = 'Saved';

    const selected = await runAct(page, [{ action: 'select', ref: 'e4', value: 'Dark' }]);
    expect(selected.outcomes[0].line).toBe('select e4 ok');
    expect(select.value).toBe('dark');

    const scrolled = await runAct(page, [{ action: 'scroll', dy: 320 }]);
    expect(scrolled.outcomes[0].line).toBe('scroll 320 ok');
    expect(page.window.scrolledBy).toBe(320);

    const waited = await runAct(page, [{ action: 'wait', text: 'Saved', ms: 0 }]);
    expect(waited.outcomes[0].line).toBe('wait text ok');
  });

  it('rejects a disabled control', async () => {
    const save = new FakeElement('BUTTON', 'Save');
    save.disabled = true;
    save.setAttribute('data-emcp-ref', 'e1');
    const page = createPage([save]);
    const result = await runAct(page, [{ action: 'click', ref: 'e1' }]);
    expect(result.outcomes[0].line).toContain('FAIL disabled');
    expect(save.events).not.toContain('click');
  });

  it('parses a snapshot payload and unwraps the evaluate prefix', () => {
    const parsed = parseSnapshotPayload(
      '{"title":"Inbox","url":"http://127.0.0.1/#/inbox","entries":[{"ref":"e1","role":"button","name":"Save"},{"ref":"nope","role":"button","name":"Skip"}],"omitted":2,"alerts":["Saved"],"errorCount":0,"lastError":"","refsReset":false}',
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.omitted).toBe(2);
    expect(unwrapEvaluateString('✅ Command executed: {"entries":[]}')).toBe('{"entries":[]}');
    expect(diffSnapshot([{ ref: 'e1', role: 'button', name: 'Save' }], [])).toMatchObject({
      removed: [{ ref: 'e1' }],
      unchanged: 0,
    });
  });

  it('registers the two agent tools with tight schemas', () => {
    const snapshot = commandsByName.get('electron_snapshot');
    const act = commandsByName.get('electron_act');
    expect(snapshot?.operationType).toBe('query');
    expect(act?.operationType).toBe('command');
    expect(snapshot?.schema.parse({})).toMatchObject({ limit: 60, report: 'full' });
    expect(act?.schema.parse({ steps: [{ action: 'scroll', dy: 10 }] })).toMatchObject({
      report: 'auto',
      limit: 60,
    });
    expect(() => snapshot?.schema.parse({ limit: 5 })).toThrow();
    expect(() => act?.schema.parse({ steps: [] })).toThrow();
    expect(() =>
      act?.schema.parse({ steps: Array.from({ length: 9 }, () => ({ action: 'scroll' })) }),
    ).toThrow();
    expect(() => act?.schema.parse({ steps: [{ action: 'click' }] })).toThrow();
    expect(() => act?.schema.parse({ steps: [{ action: 'fill', ref: 'e1' }] })).toThrow();
    expect(() =>
      act?.schema.parse({ steps: [{ action: 'click', selector: '<script>alert(1)</script>' }] }),
    ).toThrow();
    expect(
      act?.schema.parse({ steps: [{ action: 'fill', ref: 'e2', value: '' }] }).steps[0],
    ).toMatchObject({ action: 'fill', ref: 'e2', value: '' });
  });
});
