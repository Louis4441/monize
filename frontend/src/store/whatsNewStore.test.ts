import { describe, it, expect, beforeEach } from 'vitest';
import { useWhatsNewStore } from './whatsNewStore';

describe('whatsNewStore', () => {
  beforeEach(() => {
    useWhatsNewStore.setState({ isOpen: false });
  });

  it('opens and closes the modal', () => {
    expect(useWhatsNewStore.getState().isOpen).toBe(false);

    useWhatsNewStore.getState().open();
    expect(useWhatsNewStore.getState().isOpen).toBe(true);

    useWhatsNewStore.getState().close();
    expect(useWhatsNewStore.getState().isOpen).toBe(false);
  });
});
