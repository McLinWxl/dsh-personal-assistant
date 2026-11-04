// Example configuration for the activity scenario. Validation itself is independent
// of these dimensions; a production data root will own a versioned vocabulary.
export const activityContextSchema = {
  venue: { type: 'string', values: ['indoor', 'outdoor', 'mixed'], description: '物理环境：室内、室外、混合' },
  checkIn: { type: 'boolean', description: '是否需要来宾签到' },
};

export function validateContext(context, schema) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('INVALID_CONTEXT');
  for (const [key, value] of Object.entries(context)) {
    const dimension = schema[key];
    if (!dimension || typeof value !== dimension.type || dimension.values && !dimension.values.includes(value)) {
      throw new Error('CONTEXT_SCHEMA_MISMATCH: use the declared keys, types and values: ' + JSON.stringify(schema));
    }
  }
  return context;
}
