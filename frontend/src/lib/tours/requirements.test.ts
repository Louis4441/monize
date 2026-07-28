import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAllAccounts = vi.fn();
const getSecurities = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...args: unknown[]) => getAllAccounts(...args) },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurities: (...args: unknown[]) => getSecurities(...args) },
}));

import { resolveTourRequirements, isTourOfferable } from './requirements';
import type { TourDefinition } from './types';

function tour(overrides: Partial<TourDefinition> = {}): TourDefinition {
  return {
    id: 'test/tour',
    area: 'intro',
    i18nPrefix: 'test.tour',
    steps: [],
    ...overrides,
  };
}

describe('resolveTourRequirements', () => {
  beforeEach(() => {
    getAllAccounts.mockReset().mockResolvedValue([]);
    getSecurities.mockReset().mockResolvedValue([]);
  });

  it('reports both requirements met when the user has the data', async () => {
    getAllAccounts.mockResolvedValue([{ id: 'a' }]);
    getSecurities.mockResolvedValue([{ id: 's' }]);

    await expect(resolveTourRequirements()).resolves.toEqual({
      transactionEntry: true,
      securitiesExist: true,
    });
  });

  it('reports each requirement independently', async () => {
    getAllAccounts.mockResolvedValue([{ id: 'a' }]);
    getSecurities.mockResolvedValue([]);

    await expect(resolveTourRequirements()).resolves.toEqual({
      transactionEntry: true,
      securitiesExist: false,
    });
  });

  it('asks only for active securities, as the list shows by default', async () => {
    await resolveTourRequirements();
    expect(getSecurities).toHaveBeenCalledWith();
  });

  it('excludes closed accounts from the account check', async () => {
    await resolveTourRequirements();
    expect(getAllAccounts).toHaveBeenCalledWith(false);
  });

  it('assumes a requirement is met when its lookup fails', async () => {
    getSecurities.mockRejectedValue(new Error('offline'));

    // A network blip must not silently hide a tour the user can take; a step
    // with nothing to point at is handled gracefully, a missing tour is not.
    await expect(resolveTourRequirements()).resolves.toMatchObject({
      securitiesExist: true,
    });
  });

  it('does not let one failed lookup mask the other answer', async () => {
    getAllAccounts.mockRejectedValue(new Error('offline'));
    getSecurities.mockResolvedValue([]);

    await expect(resolveTourRequirements()).resolves.toEqual({
      transactionEntry: true,
      securitiesExist: false,
    });
  });
});

describe('isTourOfferable', () => {
  it('always offers an ungated tour, even before the lookup resolves', () => {
    expect(isTourOfferable(tour(), null)).toBe(true);
  });

  it('offers a gated tour once its requirement is met', () => {
    expect(
      isTourOfferable(tour({ requiresData: 'securitiesExist' }), {
        transactionEntry: true,
        securitiesExist: true,
      }),
    ).toBe(true);
  });

  it('withholds a gated tour whose requirement is not met', () => {
    expect(
      isTourOfferable(tour({ requiresData: 'securitiesExist' }), {
        transactionEntry: true,
        securitiesExist: false,
      }),
    ).toBe(false);
  });

  it('withholds a gated tour until the lookup resolves', () => {
    // Offering it and taking it away again would be worse than a short wait.
    expect(
      isTourOfferable(tour({ requiresData: 'securitiesExist' }), null),
    ).toBe(false);
  });

  it('reads the requirement the tour actually names', () => {
    expect(
      isTourOfferable(tour({ requiresData: 'transactionEntry' }), {
        transactionEntry: false,
        securitiesExist: true,
      }),
    ).toBe(false);
  });
});
