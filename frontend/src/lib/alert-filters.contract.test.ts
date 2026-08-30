import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYSTEM_ALERT_TYPES } from '@/types/budget';
import { alertCategory } from './alert-filters';

/**
 * The system-vs-financial alert classification is one set written twice: the
 * backend's SYSTEM_ALERT_TYPES (the dismiss-matching endpoint restricts its
 * UPDATE on it) and the frontend mirror in `types/budget.ts` (the panel's
 * category filter and the local removal after a delete-all read it). If the
 * two drift, delete-all removes rows the user's filter never showed -- or
 * leaves rows it did. Nothing compiles the layers against each other, so this
 * reads the backend entity and compares member for member, the same trade as
 * `ai-query-budgets.contract.test.ts`.
 */
const BACKEND_ENTITY = resolve(
  __dirname,
  '../../../backend/src/budgets/entities/budget-alert.entity.ts',
);

function parseBackendSystemAlertTypes(): string[] {
  const source = readFileSync(BACKEND_ENTITY, 'utf8');
  const block = source.match(
    /export const SYSTEM_ALERT_TYPES[^=]*=\s*\[([\s\S]*?)\];/,
  );
  if (!block) {
    throw new Error(
      'SYSTEM_ALERT_TYPES not found in the backend entity -- this guard has lost its subject',
    );
  }
  return [...block[1].matchAll(/AlertType\.([A-Z_]+)/g)].map((m) => m[1]);
}

describe('SYSTEM_ALERT_TYPES contract', () => {
  const backend = parseBackendSystemAlertTypes();

  it('parses the backend set it is checked against', () => {
    expect(backend.length).toBeGreaterThan(0);
  });

  it('mirrors the backend set exactly', () => {
    expect([...SYSTEM_ALERT_TYPES].sort()).toEqual([...backend].sort());
  });

  it('classifies every backend AlertType, so a new type cannot fall between the layers', () => {
    const source = readFileSync(BACKEND_ENTITY, 'utf8');
    const enumBlock = source.match(/export enum AlertType \{([\s\S]*?)\n\}/);
    expect(enumBlock).toBeTruthy();
    const allTypes = [...enumBlock![1].matchAll(/^\s*([A-Z_]+)\s*=/gm)].map(
      (m) => m[1],
    );
    expect(allTypes.length).toBeGreaterThan(0);
    for (const type of allTypes) {
      // Membership decides the category; both answers must be reachable.
      expect(['system', 'financial']).toContain(
        alertCategory(type as (typeof SYSTEM_ALERT_TYPES)[number]),
      );
    }
    // And the frontend set names nothing the backend enum does not have.
    for (const type of SYSTEM_ALERT_TYPES) {
      expect(allTypes).toContain(type);
    }
  });
});
