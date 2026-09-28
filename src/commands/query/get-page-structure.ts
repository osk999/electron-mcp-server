import { executeInElectron } from '../../utils/electron-connection';
import { generatePageStructureCommand } from '../../utils/electron-input-commands';
import { WindowTargetSchema } from '../shared/window-target';
import { defineCommand } from '../types';

const schema = WindowTargetSchema;

/**
 * Organized JSON overview of the page: title, url, framework guess,
 * and lists of buttons / inputs / selects / links with key attributes.
 */
export const getPageStructure = defineCommand({
  name: 'electron_get_page_structure',
  description:
    'Get an organized overview of visible controls. Each control is named by its own text or aria-label. Returns JSON without utility class strings.',
  schema,
  operationType: 'query',
  async execute(_args, target) {
    return executeInElectron(generatePageStructureCommand(), target);
  },
});
