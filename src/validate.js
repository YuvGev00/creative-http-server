'use strict';

function checkType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

function validate(schema, data) {
  const errors = [];
  const obj = data && typeof data === 'object' ? data : {};

  for (const [field, rule] of Object.entries(schema)) {
    const value = obj[field];
    const present = value !== undefined && value !== null && value !== '';

    if (!present) {
      if (rule.required) {
        errors.push({ field, message: `"${field}" is required` });
      }
      continue;
    }

    if (rule.type && !checkType(value, rule.type)) {
      errors.push({ field, message: `"${field}" must be of type ${rule.type}` });
      continue;
    }

    if (rule.enum && !rule.enum.includes(value)) {
      errors.push({
        field,
        message: `"${field}" must be one of: ${rule.enum.join(', ')}`,
      });
    }

    if (rule.pattern instanceof RegExp && typeof value === 'string' && !rule.pattern.test(value)) {
      errors.push({ field, message: `"${field}" has an invalid format` });
    }

    if (rule.min !== undefined) {
      const measure = rule.type === 'number' ? value : (value.length ?? 0);
      if (measure < rule.min) {
        errors.push({ field, message: `"${field}" must be at least ${rule.min}` });
      }
    }
    if (rule.max !== undefined) {
      const measure = rule.type === 'number' ? value : (value.length ?? 0);
      if (measure > rule.max) {
        errors.push({ field, message: `"${field}" must be at most ${rule.max}` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validate };
