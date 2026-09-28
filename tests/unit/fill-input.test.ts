import { describe, it, expect, afterEach } from 'vitest';
import { generateFillInputCommand } from '../../src/utils/electron-input-commands';

type ReactInput = {
  tagName: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  disabled: boolean;
  readOnly: boolean;
  value: string;
  parentElement: { tagName: string; parentElement: null; children: unknown[] } | null;
  focus: () => void;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { width: number; height: number; top: number; left: number };
  closest: () => null;
  dispatchEvent: (event: Event) => boolean;
  _valueTracker: { setValue: (value: string) => void; getValue: () => string };
};

function installReactInput(ariaLabel: string): { input: ReactInput; events: string[]; setterCalls: string[] } {
  const events: string[] = [];
  const setterCalls: string[] = [];
  const values = new WeakMap<object, string>();
  const trackerValues = new WeakMap<object, string>();

  function InputElement() {}
  Object.defineProperty(InputElement.prototype, 'value', {
    configurable: true,
    get(this: object) {
      return values.get(this) ?? '';
    },
    set(this: object, next: string) {
      setterCalls.push(String(next));
      values.set(this, String(next));
    },
  });

  const input = Object.create(InputElement.prototype) as ReactInput;
  input.tagName = 'INPUT';
  input.type = 'text';
  input.name = 'q';
  input.id = '';
  input.placeholder = ariaLabel;
  input.disabled = false;
  input.readOnly = false;
  input.parentElement = { tagName: 'DIV', parentElement: null, children: [] };
  input.focus = () => {};
  input.getAttribute = (name) => (name === 'aria-label' ? ariaLabel : null);
  input.getBoundingClientRect = () => ({ width: 200, height: 24, top: 0, left: 0 });
  input.closest = () => null;
  input.dispatchEvent = (event) => {
    events.push(event.type);
    return true;
  };
  input._valueTracker = {
    setValue(value: string) {
      trackerValues.set(input, value);
    },
    getValue() {
      return trackerValues.get(input) ?? '';
    },
  };
  values.set(input, '');

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLInputElement: (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement,
  };

  const dom = {
    querySelector(selector: string) {
      return selector === 'input[name="q"]' ? input : null;
    },
    querySelectorAll() {
      return [input];
    },
    getElementById() {
      return null;
    },
  };

  Object.assign(globalThis, {
    window: globalThis,
    document: dom,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: InputElement,
  });

  return {
    input,
    events,
    setterCalls,
    restore() {
      Object.assign(globalThis, previous);
    },
  } as never;
}

describe('generateFillInputCommand — React controlled input', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('sets the native value and fires input so a following read matches the filled text', () => {
    const filled = 'ElectronAccessCheck';
    const harness = installReactInput('Search or create Bots') as ReturnType<typeof installReactInput> & {
      restore: () => void;
    };
    restore = harness.restore;

    const script = generateFillInputCommand('input[name="q"]', filled, '');
    expect(script).toContain('HTMLInputElement.prototype');
    expect(script).toContain("new Event('input'");

    const result = new Function(
      'var window = globalThis; var document = globalThis.document; var getComputedStyle = globalThis.getComputedStyle; return (' +
        script +
        ');',
    )() as string;

    expect(harness.setterCalls).toEqual([filled]);
    expect(harness.input.value).toBe(filled);
    expect(harness.events).toContain('input');
    expect(result).toContain(`Successfully filled input`);
    expect(result).toContain(filled);
  });
});
