import { BODY_TEXT_LIMIT, bodyTextExpression } from '../../utils/body-text';
import { executeInElectron } from '../../utils/electron-connection';
import { WindowTargetSchema } from '../shared/window-target';
import { defineCommand } from '../types';

const schema = WindowTargetSchema;

/**
 * Returns `document.body.innerText`. Pages longer than BODY_TEXT_LIMIT keep
 * the start of the text and an explicit truncation marker.
 */
export const getBodyText = defineCommand({
  name: 'electron_get_body_text',
  description: `Get document.body.innerText. Pages longer than ${BODY_TEXT_LIMIT} characters end with an explicit [truncated, N more characters] marker.`,
  schema,
  operationType: 'query',
  async execute(_args, target) {
    return executeInElectron(bodyTextExpression(), target);
  },
});
