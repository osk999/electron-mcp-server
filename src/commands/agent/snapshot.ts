import { z } from 'zod';
import { publishSnapshot, SNAPSHOT_LIMIT_DEFAULT } from '../../utils/agent-snapshot';
import { windowTargetFields } from '../shared/window-target';
import { defineCommand } from '../types';

const schema = z.object({
  ...windowTargetFields,
  limit: z
    .number()
    .int()
    .min(10)
    .max(200)
    .default(SNAPSHOT_LIMIT_DEFAULT)
    .describe('Max controls in the outline. Default 60.'),
  report: z
    .enum(['full', 'diff', 'auto'])
    .default('full')
    .describe(
      'full lists every control. diff lists changes since the last outline on this window. auto uses a diff when little changed.',
    ),
});

/**
 * Short text outline of the page. One line per control, with a stable ref
 * the model can hand to `electron_act`. Much smaller than a screenshot or
 * `electron_get_page_structure`.
 */
export const snapshot = defineCommand({
  name: 'electron_snapshot',
  description:
    'Compact page outline: one line per control with a stable [ref=eN], for example - button "Save" [ref=e1]. Prefer this over a screenshot or electron_get_page_structure. Pass the ref to electron_act. report=diff returns only what changed since the last outline on this window.',
  schema,
  operationType: 'query',
  async execute(args, target) {
    return publishSnapshot(target, args.limit, args.report);
  },
});
