import { describe, expect, it } from 'vitest';
import { buildPayeeSchema } from './PayeeForm';

/**
 * The form's validation rules, tested against the schema itself.
 *
 * `PayeeForm.test.tsx` mocks `zodResolver` into a pass-through so its submit
 * handlers receive real field values, which means no rule declared in the
 * schema is exercised from there -- a malformed email submits cleanly in that
 * suite no matter what the schema says. These assertions are the ones with
 * teeth.
 */
const t = (key: string) => key;
const parse = (input: Record<string, unknown>) =>
  buildPayeeSchema(t).safeParse({ name: 'Starbucks', ...input });

describe('payee form schema', () => {
  it('accepts a well-formed email', () => {
    expect(parse({ email: 'hello@starbucks.com' }).success).toBe(true);
  });

  it('rejects a malformed email with the localized message', () => {
    const result = parse({ email: 'not an email' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['email'],
      message: 'validation.emailInvalid',
    });
  });

  it('accepts a blank email, because that is how the field is cleared', () => {
    // The form resends every field, so an emptied email arrives as "". A
    // schema that rejected it would block every save from a payee with no
    // email at all.
    expect(parse({ email: '' }).success).toBe(true);
  });

  it('accepts an omitted email', () => {
    expect(parse({}).success).toBe(true);
  });

  it('accepts a multi-line address', () => {
    expect(parse({ address: '1912 Pike Pl\nSeattle, WA 98101' }).success).toBe(
      true,
    );
  });

  it('rejects an address longer than the column holds', () => {
    expect(parse({ address: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects a phone number longer than the column holds', () => {
    expect(parse({ phone: '5'.repeat(51) }).success).toBe(false);
  });

  it('accepts a phone number in any format the user writes', () => {
    // No format rule on purpose: international numbers carry country codes,
    // brackets, spaces and extensions.
    for (const phone of ['+1 (206) 448-8762', '020 7946 0958', '555 ext. 12']) {
      expect(parse({ phone }).success).toBe(true);
    }
  });

  it('still requires a name', () => {
    expect(buildPayeeSchema(t).safeParse({ name: '' }).success).toBe(false);
  });
});
