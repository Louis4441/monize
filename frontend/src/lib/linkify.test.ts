import { describe, it, expect } from 'vitest';
import { linkifySegments } from './linkify';

/**
 * The parser behind clickable links in a description.
 *
 * Two properties carry the security argument, and both are asserted below on
 * every input rather than argued in prose: the segments concatenate back to the
 * input exactly (so linkifying cannot add, drop or alter a character), and a
 * `href` only ever exists for a scheme `toSafeExternalUrl` vouches for.
 */

const roundTrips = (text: string) =>
  linkifySegments(text)
    .map((segment) => segment.value)
    .join('');

const hrefs = (text: string) =>
  linkifySegments(text)
    .filter((segment) => segment.kind === 'link')
    .map((segment) => (segment.kind === 'link' ? segment.href : ''));

describe('linkifySegments', () => {
  it('finds the address in a description and leaves the prose around it', () => {
    expect(linkifySegments('Event tickets https://tix.test/a8Fq2 for two')).toEqual([
      { kind: 'text', value: 'Event tickets ' },
      { kind: 'link', value: 'https://tix.test/a8Fq2', href: 'https://tix.test/a8Fq2' },
      { kind: 'text', value: ' for two' },
    ]);
  });

  it('links a description that is nothing but the address', () => {
    expect(linkifySegments('https://tix.test/a8Fq2')).toEqual([
      { kind: 'link', value: 'https://tix.test/a8Fq2', href: 'https://tix.test/a8Fq2' },
    ]);
  });

  it('links every address in a description, not just the first', () => {
    expect(hrefs('https://a.test/1 and https://b.test/2')).toEqual([
      'https://a.test/1',
      'https://b.test/2',
    ]);
  });

  it('keeps text with no address as a single run', () => {
    expect(linkifySegments('Coffee with Sam')).toEqual([
      { kind: 'text', value: 'Coffee with Sam' },
    ]);
    expect(linkifySegments('')).toEqual([]);
  });

  describe('what counts as an address', () => {
    it('takes http and https, in any case', () => {
      expect(hrefs('http://a.test/x')).toEqual(['http://a.test/x']);
      expect(hrefs('HTTPS://a.test/x')).toEqual(['HTTPS://a.test/x']);
    });

    it('leaves a schemeless host as text, rather than guessing at it', () => {
      // A guess that is wrong renders a link to somewhere the writer never
      // named, which is worse than no link at all.
      expect(hrefs('www.tix.test/a8Fq2')).toEqual([]);
      expect(hrefs('tix.test/a8Fq2')).toEqual([]);
    });

    it('never draws a link for a scheme that would run something on click', () => {
      // A description is visible to joint owners and delegates, so this is the
      // case that matters: the parser must not be a way to put an executable
      // href in another person's page.
      for (const hostile of [
        'javascript:alert(1)',
        'JaVaScRiPt:alert(1)',
        'data:text/html,hello',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
      ]) {
        expect(hrefs(`see ${hostile} now`), hostile).toEqual([]);
        expect(roundTrips(`see ${hostile} now`)).toBe(`see ${hostile} now`);
      }
    });

    it('leaves a scheme with no host as text', () => {
      expect(hrefs('https://')).toEqual([]);
      expect(hrefs('https:// spaced')).toEqual([]);
    });
  });

  describe('where the address ends', () => {
    it('leaves sentence punctuation out of the link', () => {
      expect(hrefs('Tickets: https://tix.test/a.')).toEqual(['https://tix.test/a']);
      expect(hrefs('https://tix.test/a, then dinner')).toEqual(['https://tix.test/a']);
      expect(hrefs('Is it https://tix.test/a?')).toEqual(['https://tix.test/a']);
      expect(hrefs('"https://tix.test/a"')).toEqual(['https://tix.test/a']);
    });

    it('sheds a bracket that closes the prose', () => {
      expect(hrefs('(see https://tix.test/a)')).toEqual(['https://tix.test/a']);
    });

    it('keeps a bracket the address itself opened', () => {
      // Wikipedia article titles end in a balanced ")", so trimming every
      // closer would break exactly the links people paste most.
      expect(hrefs('https://en.wikipedia.test/wiki/Ticket_(disambiguation)')).toEqual([
        'https://en.wikipedia.test/wiki/Ticket_(disambiguation)',
      ]);
    });

    it('ends the address at whitespace', () => {
      expect(hrefs('https://tix.test/a https://tix.test/b')).toEqual([
        'https://tix.test/a',
        'https://tix.test/b',
      ]);
    });

    it('keeps a query string and fragment, which carry the ticket id', () => {
      expect(hrefs('https://tix.test/o?id=8&t=2#seat')).toEqual([
        'https://tix.test/o?id=8&t=2#seat',
      ]);
    });
  });

  describe('the text is never altered', () => {
    const inputs = [
      'Event tickets https://tix.test/a8Fq2 for two',
      'https://tix.test/a8Fq2',
      '(see https://tix.test/a).',
      'Tickets: https://tix.test/a, https://tix.test/b!',
      'no address here at all',
      'https://',
      'javascript:alert(1)',
      'https://en.wikipedia.test/wiki/Ticket_(x)) trailing',
      '  leading and trailing spaces  ',
      'multi\nline\nhttps://tix.test/a\nnote',
    ];

    it.each(inputs)('reproduces %j exactly', (input) => {
      expect(roundTrips(input)).toBe(input);
    });

    it('reproduces text whose trimmed punctuation lands in the next run', () => {
      expect(linkifySegments('(https://tix.test/a)')).toEqual([
        { kind: 'text', value: '(' },
        { kind: 'link', value: 'https://tix.test/a', href: 'https://tix.test/a' },
        { kind: 'text', value: ')' },
      ]);
    });

    it('merges the runs around an address it declined to link', () => {
      // A rejected candidate must not split one run of prose into two, or the
      // renderer would emit a different node shape for the same visible text.
      expect(linkifySegments('a javascript:x b')).toEqual([
        { kind: 'text', value: 'a javascript:x b' },
      ]);
    });
  });

  it('cannot be primed by a previous call (the pattern is global)', () => {
    // A `g` regex carries `lastIndex`; a shared one that is not reset returns
    // different answers for the same input on the second call.
    const text = 'https://tix.test/a and https://tix.test/b';
    expect(hrefs(text)).toEqual(hrefs(text));
  });
});
