'use strict';
// FASE 1 P9 — conservative retroactive-reassign decision rule.
const { shouldReassign } = require('../retro-operator');

describe('shouldReassign', () => {
  test('explicit prefix says a DIFFERENT operator → reassign (the Vitor→Bruno L-08 case)', () => {
    expect(shouldReassign({
      currentOperatorId: 3, // Vitor Leite
      resolved: { via: 'prefix', operatorId: 2, operatorName: 'Bruno Sarmento', ambiguous: false },
    })).toBe(true);
  });

  test('same operator → no-op', () => {
    expect(shouldReassign({
      currentOperatorId: 2,
      resolved: { via: 'prefix', operatorId: 2, ambiguous: false },
    })).toBe(false);
  });

  test('account-owner / context resolution is NOT auto-corrected (too weak for destructive change)', () => {
    expect(shouldReassign({
      currentOperatorId: 3,
      resolved: { via: 'account_owner', operatorId: 2, ambiguous: false },
    })).toBe(false);
    expect(shouldReassign({
      currentOperatorId: 3,
      resolved: { via: 'context', operatorId: 2, ambiguous: false },
    })).toBe(false);
  });

  test('ambiguous / no operator → never touch', () => {
    expect(shouldReassign({ currentOperatorId: 3, resolved: { ambiguous: true } })).toBe(false);
    expect(shouldReassign({ currentOperatorId: 3, resolved: { via: 'prefix', operatorId: null } })).toBe(false);
  });

  test('current operator null → left for disambiguation, not retro-reassign', () => {
    expect(shouldReassign({
      currentOperatorId: null,
      resolved: { via: 'prefix', operatorId: 2, ambiguous: false },
    })).toBe(false);
  });
});
