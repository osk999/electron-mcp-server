import { describe, it, expect } from 'vitest';
import { BODY_TEXT_LIMIT, SHAPE_BODY_TEXT_JS, bodyTextExpression } from '../../src/utils/body-text';
import { generatePageStructureCommand } from '../../src/utils/electron-input-commands';
import { PAGE_OVERVIEW_HELPERS_JS } from '../../src/utils/page-overview';

type OverviewControl = {
  text: string;
  ariaLabel: string;
  className?: string;
  id?: string;
  type?: string;
};

function loadOverview(): {
  shapeOverviewControl: (raw: OverviewControl) => OverviewControl;
  controlName: (el: {
    getAttribute?: (name: string) => string | null;
    childNodes?: Array<{ nodeType: number; nodeValue?: string }>;
    textContent?: string;
  }) => { text: string; ariaLabel: string };
} {
  const exports: Record<string, unknown> = {};
  new Function(
    'exports',
    `${PAGE_OVERVIEW_HELPERS_JS}
    exports.shapeOverviewControl = shapeOverviewControl;
    exports.controlName = controlName;`,
  )(exports);
  return exports as never;
}

function loadBodyText(): (text: string, limit: number) => string {
  const exports: Record<string, unknown> = {};
  new Function(
    'exports',
    `${SHAPE_BODY_TEXT_JS}
    exports.shapeBodyText = shapeBodyText;`,
  )(exports);
  return exports.shapeBodyText as (text: string, limit: number) => string;
}

const { shapeOverviewControl, controlName } = loadOverview();
const shapeBodyText = loadBodyText();

const UTILITY_CLASS =
  'sand-kit-icon-button sand-1n2onr6 sand-3nfvp2 sand-6s0dn4 sand-l56j7k sand-2lah0s';

describe('page overview shaping', () => {
  it('names a control by its visible text and drops the utility class string', () => {
    const shaped = shapeOverviewControl({
      text: 'New chat',
      ariaLabel: 'New chat',
      className: UTILITY_CLASS,
      id: 'base-ui-_r_7e_',
      type: 'button',
    });
    const payload = JSON.stringify(shaped);
    expect(payload).not.toContain('sand-1n2onr6');
    expect(payload).not.toContain(UTILITY_CLASS);
    expect(shaped.text).toBe('New chat');
    expect(shaped.ariaLabel).toBe('New chat');
    expect(shaped.className).toBeUndefined();
    expect(shaped.id).toBe('base-ui-_r_7e_');
  });

  it('uses the aria-label when the control has no own text', () => {
    const shaped = shapeOverviewControl({
      text: '',
      ariaLabel: 'New chat',
      className: UTILITY_CLASS,
    });
    expect(shaped.text).toBe('New chat');
    expect(JSON.stringify(shaped)).not.toContain('sand-1n2onr6');
  });

  it('names a button from its own text node, not a descendant dump', () => {
    const named = controlName({
      getAttribute: (name) => (name === 'aria-label' ? 'New chat' : null),
      childNodes: [{ nodeType: 1 }],
      textContent: 'New chat Search SimpleDonate ' + 'preview '.repeat(40),
    });
    expect(named.text).toBe('New chat');
    expect(named.ariaLabel).toBe('New chat');
  });

  it('the shipped overview command does not emit utility class names', () => {
    const source = generatePageStructureCommand();
    expect(source).toContain('shapeOverviewControl(');
    expect(source).toContain('controlName(');
    expect(source).not.toContain('el.className');
    expect(source).not.toContain('className:');
  });
});

describe('body text shaping', () => {
  it('does not silently cut a page at 500 characters', () => {
    const page = 'ElectronAccessCheck '.repeat(40);
    expect(page.length).toBeGreaterThan(500);
    expect(page.length).toBeLessThan(BODY_TEXT_LIMIT);
    expect(shapeBodyText(page, BODY_TEXT_LIMIT)).toBe(page);
  });

  it('marks a longer page as truncated instead of ending without notice', () => {
    const page = 'x'.repeat(BODY_TEXT_LIMIT + 25);
    const shaped = shapeBodyText(page, BODY_TEXT_LIMIT);
    expect(shaped.startsWith('x'.repeat(BODY_TEXT_LIMIT))).toBe(true);
    expect(shaped.endsWith('\n[truncated, 25 more characters]')).toBe(true);
    expect(shaped).not.toBe(page.slice(0, 500));
  });

  it('the shipped body-text script uses the same shaper and not a silent 500 cut', () => {
    const source = bodyTextExpression();
    expect(source).toContain('shapeBodyText(');
    expect(source).toContain(String(BODY_TEXT_LIMIT));
    expect(source).not.toContain('substring(0, 500)');
  });
});
