// Display OC-Declare codes while retaining the simulator's existing type names.
export const CONSTRAINT_TYPE_OPTIONS = [
  { value: 'responded_existence', label: 'AS', name: 'Association' },
  { value: 'chain_precedence', label: 'DP', name: 'Directly precedes' },
  { value: 'chain_response', label: 'DF', name: 'Directly follows' },
  { value: 'precedence', label: 'EP', name: 'Eventually precedes' },
  { value: 'response', label: 'EF', name: 'Eventually follows' },
];

export const constraintTypeLabel = type =>
  CONSTRAINT_TYPE_OPTIONS.find(option => option.value === type)?.label || type;
