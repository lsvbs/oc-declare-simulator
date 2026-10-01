import React from 'react';
import { CONSTRAINT_TYPE_OPTIONS } from './constraintTypes.mjs';

export default function ConstraintTypeSelect({ value, ...props }) {
  const known = CONSTRAINT_TYPE_OPTIONS.some(option => option.value === value);
  return (
    <select aria-label="Constraint type" {...props} value={value}>
      {!value && <option value="">constraint…</option>}
      {/* Keep imported legacy types intact until the user explicitly replaces them. */}
      {value && !known && <option value={value} disabled>{value} (loaded)</option>}
      {CONSTRAINT_TYPE_OPTIONS.map(({ value: type, label, name }) => (
        <option key={type} value={type} title={name}>{label}</option>
      ))}
    </select>
  );
}
