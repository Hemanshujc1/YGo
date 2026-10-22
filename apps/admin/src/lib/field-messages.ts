export function fieldMessages<Field extends string>(fields: readonly string[], messages: Record<Field, string>): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  for (const path of fields) {
    // The server names nested fields with dots, such as "pincodes.3".
    const field = path.replace(/\..*/, "") as Field;
    if (Object.hasOwn(messages, field)) errors[field] = messages[field];
  }
  return errors;
}
