import { describe, expect, it } from 'vitest';
import { bannerForReason } from './gameOverFormat';

describe('bannerForReason', () => {
  it('maps "busted" to the BUSTED banner', () => {
    expect(bannerForReason('busted')).toEqual({ label: 'BUSTED', variant: 'busted' });
  });

  it('maps "wrecked" to the WRECKED banner', () => {
    expect(bannerForReason('wrecked')).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });

  it('degrades "quit" to the WRECKED banner (no dedicated quit visual exists)', () => {
    expect(bannerForReason('quit')).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });

  it('degrades a missing reason (undefined) to WRECKED — the debug-transition case', () => {
    expect(bannerForReason(undefined)).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });

  it('degrades a null reason to WRECKED', () => {
    expect(bannerForReason(null)).toEqual({ label: 'WRECKED', variant: 'wrecked' });
  });
});
