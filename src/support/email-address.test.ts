import { describe, it, expect } from 'vitest';
import { parseEmailAddress, extractEmail } from './email-address.js';

describe('parseEmailAddress', () => {
  it('parses a quoted display name with angle-bracketed email', () => {
    // This is the exact shape the Gmail `From` header takes, and the exact case
    // the old code mishandled — storing the WHOLE string as the "email" and so
    // making every Shopify order lookup miss.
    expect(parseEmailAddress('"Jane Doe" <jane@acme.com>')).toEqual({
      name: 'Jane Doe',
      email: 'jane@acme.com',
    });
  });

  it('parses an unquoted display name', () => {
    expect(parseEmailAddress('Jane Doe <jane@acme.com>')).toEqual({
      name: 'Jane Doe',
      email: 'jane@acme.com',
    });
  });

  it('parses a bare email', () => {
    expect(parseEmailAddress('jane@acme.com')).toEqual({ name: null, email: 'jane@acme.com' });
  });

  it('parses an angle-bracketed email with no name', () => {
    expect(parseEmailAddress('<jane@acme.com>')).toEqual({ name: null, email: 'jane@acme.com' });
  });

  it('lower-cases and trims the email', () => {
    expect(parseEmailAddress('  Jane <JANE@Acme.COM>  ').email).toBe('jane@acme.com');
  });

  it('returns nulls for empty / nullish / no-email input', () => {
    expect(parseEmailAddress('')).toEqual({ name: null, email: null });
    expect(parseEmailAddress(null)).toEqual({ name: null, email: null });
    expect(parseEmailAddress(undefined)).toEqual({ name: null, email: null });
    expect(parseEmailAddress('not an address')).toEqual({ name: 'not an address', email: null });
  });

  it('extractEmail returns just the normalised email', () => {
    expect(extractEmail('"Jane Doe" <Jane@Acme.com>')).toBe('jane@acme.com');
    expect(extractEmail('garbage')).toBeNull();
  });
});
