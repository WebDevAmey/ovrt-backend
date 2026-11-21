import { describe, it, expect } from 'vitest';
import { buildOrderNameClause } from './order-query.js';

describe('buildOrderNameClause — # is optional, and prefixed names still match', () => {
  it('a bare number matches both the #-form and the raw form', () => {
    expect(buildOrderNameClause('1234')).toBe('(name:#1234 OR name:1234)');
  });

  it('a #-prefixed number is normalized to the same two-form match as a bare one', () => {
    // The leading # is stripped during normalization, so "#1234" and "1234"
    // produce the identical clause — # truly is optional for the customer.
    expect(buildOrderNameClause('#1234')).toBe('(name:#1234 OR name:1234)');
  });

  it('strips a leading "# " with a space, and extra hashes/whitespace', () => {
    expect(buildOrderNameClause('# 1234')).toBe('(name:#1234 OR name:1234)');
    expect(buildOrderNameClause('  ##1234  ')).toBe('(name:#1234 OR name:1234)');
  });

  it('a store-prefixed order name (EXP1234) is matched, not forced into #<num>', () => {
    expect(buildOrderNameClause('EXP1234')).toBe('(name:#EXP1234 OR name:EXP1234)');
  });

  it('returns null when there is nothing usable', () => {
    expect(buildOrderNameClause(null)).toBeNull();
    expect(buildOrderNameClause(undefined)).toBeNull();
    expect(buildOrderNameClause('   ')).toBeNull();
    expect(buildOrderNameClause('#')).toBeNull();
  });
});
