import { describe, expect, it } from 'vitest';
import {
  addressQuery,
  detectMapPlatform,
  mailtoHref,
  mapsUrl,
  telHref,
} from './contact-links';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120';

describe('detectMapPlatform', () => {
  it('recognises iOS devices', () => {
    expect(detectMapPlatform(IOS_UA)).toBe('ios');
  });

  it('recognises Android devices', () => {
    expect(detectMapPlatform(ANDROID_UA)).toBe('android');
  });

  it('falls back to a web map everywhere else', () => {
    expect(detectMapPlatform(DESKTOP_UA)).toBe('other');
    expect(detectMapPlatform(undefined)).toBe('other');
    expect(detectMapPlatform('')).toBe('other');
  });
});

describe('addressQuery', () => {
  it('collapses a multi-line address to one line', () => {
    expect(addressQuery('1912 Pike Pl\nSeattle, WA 98101')).toBe(
      '1912 Pike Pl, Seattle, WA 98101',
    );
  });

  it('drops blank lines and repeated whitespace', () => {
    expect(addressQuery('  1912   Pike Pl \n\n\n  Seattle  ')).toBe(
      '1912 Pike Pl, Seattle',
    );
  });
});

describe('mapsUrl', () => {
  const point = { latitude: 47.609722, longitude: -122.342201 };
  const address = '1912 Pike Pl, Seattle';

  it('opens Apple Maps at the coordinates on iOS', () => {
    const url = mapsUrl({ ...point, address, platform: 'ios' });

    expect(url).toContain('https://maps.apple.com/?ll=47.609722,-122.342201');
    expect(url).toContain(`q=${encodeURIComponent(address)}`);
  });

  it('drops a geo: pin at the coordinates on Android', () => {
    const url = mapsUrl({ ...point, address, platform: 'android' });

    // The q=lat,lng(Label) form pins the exact point; a bare q= would search
    // near it and can land on a different building.
    expect(url).toBe(
      `geo:47.609722,-122.342201?q=47.609722,-122.342201(${encodeURIComponent(address)})`,
    );
  });

  it('links a web map elsewhere', () => {
    const url = mapsUrl({ ...point, address, platform: 'other' });

    expect(url).toContain('openstreetmap.org');
    expect(url).toContain('mlat=47.609722');
    expect(url).toContain('mlon=-122.342201');
  });

  describe('when the address was never located', () => {
    const unlocated = { latitude: null, longitude: null, address };

    it('still hands the address over as a search on iOS', () => {
      expect(mapsUrl({ ...unlocated, platform: 'ios' })).toBe(
        `https://maps.apple.com/?q=${encodeURIComponent(address)}`,
      );
    });

    it('still hands the address over as a search on Android', () => {
      expect(mapsUrl({ ...unlocated, platform: 'android' })).toBe(
        `geo:0,0?q=${encodeURIComponent(address)}`,
      );
    });

    it('still hands the address over as a search on the web', () => {
      expect(mapsUrl({ ...unlocated, platform: 'other' })).toContain(
        `search?query=${encodeURIComponent(address)}`,
      );
    });
  });

  it('returns null when there is neither a point nor an address', () => {
    expect(
      mapsUrl({ latitude: null, longitude: null, address: '  ', platform: 'ios' }),
    ).toBeNull();
  });

  it('encodes an address that would otherwise break out of the query', () => {
    const url = mapsUrl({
      latitude: null,
      longitude: null,
      address: 'A & B St #3?x=1',
      platform: 'other',
    });

    expect(url).not.toContain('&x=1');
    expect(url).toContain(encodeURIComponent('A & B St #3?x=1'));
  });
});

describe('telHref', () => {
  it('strips formatting a stored number carries', () => {
    expect(telHref('+1 (555) 010-1234')).toBe('tel:+15550101234');
  });

  it('keeps a number with no country code', () => {
    expect(telHref('555-0100')).toBe('tel:5550100');
  });

  it('drops an extension suffix rather than dialling it as digits', () => {
    // "ext" contributes no digits, so only the number itself survives.
    expect(telHref('555 0100 ext. 12')).toBe('tel:555010012');
  });

  it('returns null for a value holding no number at all', () => {
    expect(telHref('call the shop')).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });
});

describe('mailtoHref', () => {
  it('builds a mailto for a well-formed address', () => {
    expect(mailtoHref('hello@starbucks.com')).toBe(
      'mailto:hello%40starbucks.com',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(mailtoHref('  hello@starbucks.com  ')).toBe(
      'mailto:hello%40starbucks.com',
    );
  });

  it.each([
    ['plain text', 'not an email'],
    ['no domain dot', 'hello@localhost'],
    ['an embedded newline, which is how a header gets injected', 'a@b.com\nBcc: x@y.com'],
    ['an internal space', 'hello world@example.com'],
    ['nothing before the @', '@example.com'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, value) => {
    expect(mailtoHref(value)).toBeNull();
  });

  it('returns null for absent values', () => {
    expect(mailtoHref(null)).toBeNull();
    expect(mailtoHref(undefined)).toBeNull();
  });
});
