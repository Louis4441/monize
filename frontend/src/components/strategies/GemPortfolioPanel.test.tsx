import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemPortfolioPanel } from './GemPortfolioPanel';
import { gemPosition } from '@/test/gem-fixtures';

describe('GemPortfolioPanel', () => {
  it('lists every instrument the strategy accounts hold, valued', () => {
    render(<GemPortfolioPanel position={gemPosition()} noAccount={false} noPosition={false} />);

    expect(screen.getByText('Broker IRA')).toBeInTheDocument();
    expect(screen.getByText('Holdings (3)')).toBeInTheDocument();
    expect(screen.getByText('SPDR S&P 500 ETF (SPY)')).toBeInTheDocument();
    expect(
      screen.getByText('WisdomTree Artificial Intelligence UCITS ETF (WTAI)'),
    ).toBeInTheDocument();
    // Each value appears twice: once in the holdings list, once in the table
    // that shows how the compliance figure was worked out.
    expect(screen.getAllByText('$23,076.26').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$543.12').length).toBeGreaterThan(0);
    // The whole portfolio is the denominator, so its total is shown.
    expect(screen.getAllByText('$64,643.84').length).toBeGreaterThan(0);
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('marks which holdings are the target and which are outside the strategy', () => {
    render(<GemPortfolioPanel position={gemPosition()} noAccount={false} noPosition={false} />);

    // The notes hang off the unit count, separated by a decorative middot --
    // "--" is comment style and must never reach the screen.
    expect(screen.getByText(/1,170 units/)).toHaveTextContent('target instrument');
    expect(screen.getByText(/6 units/)).toHaveTextContent('not part of the strategy');
    expect(screen.queryByText(/units --/)).toBeNull();
    expect(screen.getByText(/Everything held in these accounts counts/)).toBeInTheDocument();
  });

  it('links each holding to its instrument and names a partial match', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [
            {
              role: null,
              securityId: 'sec-iusq',
              symbol: 'IUSQ',
              name: 'iShares MSCI ACWI UCITS ETF',
              quantity: 51,
              marketValue: 22910.08,
              // A fifth of a world tracker is already in the EM target.
              isTargetInstrument: false,
              matchPercent: 20,
              matchedByInstrument: false,
              isCash: false,
              matchedMarkets: [],
            },
          ],
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    expect(
      screen.getByRole('link', { name: /iShares MSCI ACWI UCITS ETF/ }),
    ).toHaveAttribute('href', '/securities/sec-iusq');
    expect(screen.getByText(/51 units/)).toHaveTextContent(
      '20% estimated exposure to the target market',
    );
  });

  it('lists cash as a position that counts towards nothing', () => {
    // Idle cash used to be invisible here, so an account half in cash read as
    // fully compliant. It is a row like any other, minus a ticker to link to
    // and a unit count it does not have.
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [
            {
              role: null,
              isCash: true,
              securityId: null,
              symbol: null,
              name: null,
              quantity: null,
              marketValue: 5000,
              isTargetInstrument: false,
              matchPercent: 0,
              matchedByInstrument: false,
              matchedMarkets: [],
            },
          ],
          totalMarketValue: 10000,
          exactTargetPercent: 50,
          // Cash is not an undescribed instrument, so it does not count here.
          instrumentMatchedCount: 0,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    // Named in the positions list and again in the working table, and never
    // as "not assigned" -- cash is not a gap in the configuration.
    expect(screen.getAllByText('Cash')).toHaveLength(2);
    expect(screen.queryByText(/Not assigned/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Uninvested — counts towards nothing/),
    ).toBeInTheDocument();
    // No instrument link, and none of the "fill in the breakdown" prompts:
    // no breakdown would ever make cash match a market.
    expect(screen.queryByRole('link', { name: /Cash/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/matched by instrument/i)).not.toBeInTheDocument();
  });

  it('still shows the working-out when the total cannot be priced', () => {
    // One unpriced holding makes the total unknown -- and the working table is
    // exactly where the row responsible is named, so hiding it there left the
    // user with an unexplained blank.
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [
            {
              role: null,
              isCash: false,
              securityId: 'sec-unpriced',
              symbol: 'ZZZ',
              name: 'A fund with no price',
              quantity: 10,
              marketValue: null,
              isTargetInstrument: false,
              matchPercent: 0,
              matchedByInstrument: true,
              matchedMarkets: [],
            },
          ],
          totalMarketValue: null,
          exactTargetPercent: null,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    expect(screen.getByText('Holding by holding')).toBeInTheDocument();
    expect(screen.getByText('ZZZ')).toBeInTheDocument();
    expect(
      screen.getByText(/The share cannot be worked out until the holdings can be priced/),
    ).toBeInTheDocument();
  });

  it('shows the allocation arithmetic and the exposure beside it', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [
            {
              role: null,
              securityId: 'sec-iusq',
              symbol: 'IUSQ',
              name: 'iShares MSCI ACWI UCITS ETF',
              quantity: 51,
              marketValue: 10000,
              isTargetInstrument: false,
              matchPercent: 20,
              matchedByInstrument: false,
              isCash: false,
              matchedMarkets: [
                { name: 'china', percent: 12 },
                { name: 'india', percent: 8 },
              ],
            },
          ],
          totalMarketValue: 10000,
          exactTargetPercent: 20,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    // Two separate columns, and the operational one is a yes/no: this fund is
    // not the instrument the signal named, so it is sold whatever its
    // exposure. The overlapping markets stay available as the estimate's
    // working, on the cell's title.
    expect(screen.getByText('Is this the target instrument?')).toBeInTheDocument();
    expect(screen.getByText('No — sold')).toBeInTheDocument();
    expect(
      screen.getAllByText('Estimated exposure to the target market').length,
    ).toBeGreaterThan(0);
    expect(screen.getByTitle('china 12%, india 8%')).toHaveTextContent('20%');
    expect(
      screen.getByText(/\$2,000\.00 of \$10,000\.00 is held in the target instrument/),
    ).toBeInTheDocument();
  });

  it('names a holding the comparison could only match by ticker', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [
            {
              role: null,
              securityId: 'sec-mystery',
              symbol: 'WTAI',
              name: 'AI ETF',
              quantity: 6,
              marketValue: 500,
              isTargetInstrument: false,
              // No breakdown of its own: unknown exposure, not zero exposure.
              matchPercent: null,
              matchedByInstrument: true,
              isCash: false,
              matchedMarkets: [],
            },
          ],
          totalMarketValue: 500,
          exactTargetPercent: 0,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    // No breakdown of its own: the exposure is unknown, and the row says so
    // instead of printing a confident zero beside a fund nobody measured.
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    expect(screen.getByText('No — sold')).toBeInTheDocument();
  });

  it('says the exposure estimate is an estimate, and where it fell short', () => {
    render(<GemPortfolioPanel position={gemPosition()} noAccount={false} noPosition={false} />);

    expect(screen.getByText(/compared by country/)).toBeInTheDocument();
    expect(
      screen.getByText(/only the target instrument itself counts as holding the target/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 holding has no structure recorded/),
    ).toBeInTheDocument();
  });

  it('blames the target, and does not print a zero it cannot support', () => {
    // The holding may have a full country split; when the *target* has none
    // there is nothing to compare it with, and saying "no breakdown recorded"
    // on the holding's row sends the reader to fix the wrong instrument.
    render(
      <GemPortfolioPanel
        position={gemPosition({
          basis: 'INSTRUMENT',
          dimension: null,
          requiredDimension: 'COUNTRY',
          holdings: [
            {
              role: null,
              securityId: 'sec-iusq',
              symbol: 'IUSQ',
              name: 'iShares MSCI ACWI UCITS ETF',
              quantity: 51,
              marketValue: 10000,
              isTargetInstrument: false,
              // The target has no structure to compare with, so the exposure
              // of a fully described holding is unknown all the same.
              matchPercent: null,
              matchedByInstrument: true,
              isCash: false,
              matchedMarkets: [],
            },
          ],
          totalMarketValue: 10000,
          exactTargetPercent: 0,
          marketExposurePercent: null,
          marketExposureAvailable: false,
          marketExposureDimension: null,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    // The estimate is unavailable, and the reason names the target's missing
    // geographic structure rather than the holding, which is fully described.
    expect(
      screen.getByText(
        /Market exposure cannot be estimated, because EMIM has no country structure recorded in Monize/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Compliance with the signal is still calculated exactly/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    // Never a confident zero for an exposure nobody could measure. The 0% that
    // does appear is the exact allocation, which really is nothing.
    const exposureCells = screen
      .getAllByRole('cell')
      .filter((cell) => cell.textContent?.includes('%'));
    expect(exposureCells).toHaveLength(0);
  });

  it('says when it could only compare tickers', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          basis: 'INSTRUMENT',
          dimension: null,
          requiredDimension: 'COUNTRY',
          instrumentMatchedCount: 3,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );

    // The notice names the target and the exact breakdown to fill in. Saying
    // "country, asset class or sector" would send the reader to fill in one
    // that cannot decide an equity role.
    expect(
      screen.getByText(
        /EMIM has no country structure recorded in Monize/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Fill in the instrument’s geographic structure'),
    ).toBeInTheDocument();
    // The fallback notice stands alone; it must not also claim a comparison.
    expect(screen.queryByText(/compared by country/)).toBeNull();
  });

  it('names every account the holdings are summed across', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          accounts: [
            { id: 'acct-1', name: 'Broker IRA' },
            { id: 'acct-2', name: 'Broker Taxable' },
          ],
        })}
        noAccount={false}
        noPosition={false}
      />,
    );
    // Each account is a link into its own detail page, in the house style:
    // normal text colour, blue on hover, never a permanently blue anchor.
    expect(screen.getByRole('link', { name: 'Broker IRA' })).toHaveAttribute(
      'href',
      '/accounts/acct-1',
    );
    expect(screen.getByRole('link', { name: 'Broker Taxable' })).toHaveAttribute(
      'href',
      '/accounts/acct-2',
    );
    // Blue only on hover: an unprefixed `text-blue-*` would make it a
    // permanently coloured anchor, which is not the house link style.
    expect(
      screen.getByRole('link', { name: 'Broker IRA' }).className,
    ).not.toMatch(/(^|\s)text-blue-\d/);
  });

  it('marks an unpriced holding rather than valuing it at zero', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [
            {
              role: null,
              securityId: 'sec-fund',
              symbol: 'FZD2050',
              name: 'A fund with no prices',
              quantity: 755.8342,
              marketValue: null,
              isTargetInstrument: false,
              matchPercent: 0,
              matchedByInstrument: true,
              isCash: false,
              matchedMarkets: [],
            },
          ],
          totalMarketValue: null,
        })}
        noAccount={false}
        noPosition={false}
      />,
    );
    expect(screen.getByText('A fund with no prices (FZD2050)')).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
  });

  it('explains an empty strategy account without zeroed figures', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({
          holdings: [],
          current: null,
          exactTargetPercent: null,
          totalMarketValue: null,
        })}
        noAccount={false}
        noPosition
      />,
    );
    expect(screen.getByText('No position')).toBeInTheDocument();
    expect(screen.getByText(/hold no instruments yet/)).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(1);
  });

  it('asks for an account when none is assigned', () => {
    render(<GemPortfolioPanel position={null} noAccount noPosition={false} />);
    expect(screen.getByText('No account assigned')).toBeInTheDocument();
  });

  it('marks an unknown account name', () => {
    render(
      <GemPortfolioPanel
        position={gemPosition({ accounts: [] })}
        noAccount={false}
        noPosition={false}
      />,
    );
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
  });
});
