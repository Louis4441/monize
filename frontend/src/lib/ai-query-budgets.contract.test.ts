import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_QUERY_BUDGET_FIELDS } from './ai-query-budgets';

/**
 * The form's defaults and bounds are a hand-written copy of the backend's
 * `QUERY_BUDGET_SPECS`, and nothing compiles the two against each other. Drift
 * is worse than silent here: a placeholder claiming "default: 5" when the
 * server runs on 8 is believed, and a `max` the form accepts but the DTO
 * refuses turns the whole save into a 400 with no field to point at.
 *
 * So this reads the backend file and compares number for number. Parsing
 * source is crude, but the alternative -- importing across packages -- pulls
 * NestJS into the frontend's test environment for five integers.
 */
const BACKEND_SPECS = resolve(
  __dirname,
  '../../../backend/src/ai/query/query-budgets.ts',
);

interface ParsedSpec {
  field: string;
  default: number;
  min: number;
  max: number;
}

/** Every `{ ... field: "x", default: n, min: n, max: n ... }` entry in the table. */
function parseBackendSpecs(): ParsedSpec[] {
  const source = readFileSync(BACKEND_SPECS, 'utf8');
  const table = source.match(
    /export const QUERY_BUDGET_SPECS = \{([\s\S]*?)\n\} as const/,
  );
  if (!table) {
    throw new Error(
      'QUERY_BUDGET_SPECS not found in the backend source -- this guard has lost its subject',
    );
  }

  const num = (raw: string) => Number(raw.replace(/_/g, ''));
  const specs: ParsedSpec[] = [];
  const entry =
    /field:\s*"([A-Za-z]+)",[\s\S]*?default:\s*([0-9_]+),[\s\S]*?min:\s*([0-9_]+),[\s\S]*?max:\s*([0-9_]+),/g;
  for (const match of table[1].matchAll(entry)) {
    specs.push({
      field: match[1],
      default: num(match[2]),
      min: num(match[3]),
      max: num(match[4]),
    });
  }
  return specs;
}

describe('AI_QUERY_BUDGET_FIELDS', () => {
  const backend = parseBackendSpecs();

  it('parses the backend table it is checked against', () => {
    expect(backend.length).toBeGreaterThan(0);
  });

  it('covers exactly the budgets the backend declares', () => {
    expect(AI_QUERY_BUDGET_FIELDS.map((f) => f.name).sort()).toEqual(
      backend.map((s) => s.field).sort(),
    );
  });

  it.each(AI_QUERY_BUDGET_FIELDS.map((f) => [f.name, f] as const))(
    '%s matches the backend default and bounds',
    (name, field) => {
      const spec = backend.find((s) => s.field === name);
      expect(spec).toBeDefined();
      expect({
        default: field.default,
        min: field.min,
        max: field.max,
      }).toEqual({
        default: spec!.default,
        min: spec!.min,
        max: spec!.max,
      });
    },
  );
});
