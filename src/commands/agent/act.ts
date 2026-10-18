import { z } from 'zod';
import { executeInElectron } from '../../utils/electron-connection';
import { actExpression, parseActResult, type AgentActStep } from '../../utils/agent-act';
import { publishSnapshot, SNAPSHOT_LIMIT_DEFAULT, clipText } from '../../utils/agent-snapshot';
import { containsDangerousContent } from '../shared/escaping';
import { dispatchKeyPress, type KeyModifier } from '../keyboard/press-key';
import { windowTargetFields } from '../shared/window-target';
import { defineCommand } from '../types';

const stepSchema = z
  .object({
    action: z
      .enum(['click', 'fill', 'select', 'hover', 'press', 'scroll', 'wait'])
      .describe('click, fill, select, hover, press, scroll, or wait'),
    ref: z
      .string()
      .regex(/^e\d{1,4}$/)
      .optional()
      .describe('Ref from electron_snapshot, such as e3'),
    selector: z.string().min(1).max(300).optional().describe('CSS selector'),
    text: z.string().min(1).max(200).optional().describe('Visible label to match'),
    value: z
      .string()
      .max(5000)
      .optional()
      .describe('Text to fill, or option value or label to select. Empty string clears an input.'),
    key: z.string().min(1).max(32).optional().describe('Key for press, such as Enter or a'),
    modifiers: z
      .array(z.enum(['Ctrl', 'Shift', 'Alt', 'Meta']))
      .max(3)
      .optional()
      .describe('Modifiers held during press'),
    dy: z
      .number()
      .int()
      .min(-2000)
      .max(2000)
      .optional()
      .describe('Pixels to scroll when no target is given'),
    ms: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .optional()
      .describe('Wait budget in milliseconds, max 2000'),
  })
  .superRefine((step, ctx) => {
    const needsTarget =
      step.action === 'click' ||
      step.action === 'hover' ||
      step.action === 'fill' ||
      step.action === 'select';
    if (needsTarget && !step.ref && !step.selector && !step.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${step.action} needs ref, selector, or text`,
      });
    }
    if ((step.action === 'fill' || step.action === 'select') && step.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${step.action} needs value`,
      });
    }
    if (step.action === 'press' && !step.key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'press needs key',
      });
    }
    if (step.action === 'wait' && step.ms === undefined && !step.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wait needs ms or text',
      });
    }
    if (step.selector && containsDangerousContent(step.selector)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selector contains disallowed content',
      });
    }
  });

const schema = z.object({
  ...windowTargetFields,
  steps: z.array(stepSchema).min(1).max(8).describe('Ordered steps, 1 to 8'),
  limit: z
    .number()
    .int()
    .min(10)
    .max(200)
    .default(SNAPSHOT_LIMIT_DEFAULT)
    .describe('Max controls in the outline returned after the steps. Default 60.'),
  report: z
    .enum(['auto', 'full', 'diff'])
    .default('auto')
    .describe(
      'auto returns a diff when little changed, otherwise the full outline. full always lists every control. diff lists only changes. A failed step always returns the full outline.',
    ),
});

function isPageStep(step: AgentActStep): boolean {
  return step.action !== 'press';
}

/**
 * Run the DOM steps in one renderer call. A press step flushes that batch,
 * sends a real CDP key, then continues. Stops on the first failure.
 */
async function runSteps(
  steps: readonly AgentActStep[],
  target: Parameters<typeof executeInElectron>[1],
): Promise<string[]> {
  if (!target) throw new Error('act requires a target');
  const lines: string[] = [];
  let batch: AgentActStep[] = [];

  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return false;
    const current = batch;
    batch = [];
    const raw = await executeInElectron(actExpression(current), target, {
      awaitPromise: true,
      timeoutMs: Math.min(20000, 3000 + current.length * 2500),
    });
    const parsed = parseActResult(raw);
    if (parsed.lines.length === 0) {
      lines.push('act FAIL empty result');
      return true;
    }
    lines.push(...parsed.lines);
    return !parsed.ok;
  };

  for (const step of steps) {
    if (step.action === 'press') {
      if (await flush()) return lines;
      const modifiers = (step.modifiers ?? []) as KeyModifier[];
      const label = modifiers.length > 0 ? `${modifiers.join('+')}+${step.key}` : step.key;
      try {
        await dispatchKeyPress(target, step.key ?? '', modifiers);
        lines.push(`press ${label} ok`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`press ${label} FAIL ${clipText(message, 80)}`);
        return lines;
      }
      continue;
    }
    if (isPageStep(step)) batch.push(step);
  }
  await flush();
  return lines;
}

/**
 * Several UI steps plus the resulting outline, in one tool result.
 * Refs come from `electron_snapshot`. The follow-up outline is a diff when
 * the page barely changed, so the model does not re-read controls it already
 * has in context.
 */
export const act = defineCommand({
  name: 'electron_act',
  description:
    'Run 1 to 8 UI steps, then return a compact page outline (a diff when little changed). Target a control with ref from electron_snapshot. Actions: click, fill, select, hover, press, scroll, wait. One call replaces a separate action plus a follow-up read. A failed step stops the batch and returns the full outline.',
  schema,
  operationType: 'command',
  async execute(args, target) {
    let lines: string[];
    try {
      lines = await runSteps(args.steps, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines = [`act FAIL ${clipText(message, 120)}`];
    }
    const failed = lines.some((line) => line.includes(' FAIL '));
    const report = failed ? 'full' : args.report;
    const outline = await publishSnapshot(target, args.limit, report);
    return `${lines.join('\n')}\n\n${outline}`;
  },
});
