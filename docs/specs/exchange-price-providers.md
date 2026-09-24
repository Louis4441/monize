# Spec: London Stock Exchange and Deutsche Börse as price providers

Status: implemented alongside this document (issue kenlasko/monize#1415,
`approved-to-build`).

Related: `docs/backend/securities-and-providers.md` (INV-PRICE-001, the currency
acceptance rule), `backend/src/securities/providers/quote-provider.interface.ts`,
`docs/external-side-effects.md` (outbound providers through the breaker).

## 1. What this adds, and why

The catalogue priced securities through Yahoo and MSN only. A holder of a
London- or Frankfurt-listed ETF whose exact share class Yahoo does not carry (or
carries under a different listing, in a different currency) had no authoritative
source. This adds two providers that address the instrument the way each venue
does -- the LSE by its ticker (TIDM), Börse Frankfurt by ISIN -- so the price
series belongs to the listing the holder actually trades, not a same-ticker
listing on another exchange.

Both are new values of `QuoteProviderName`
(`backend/src/securities/providers/quote-provider.interface.ts`), selectable as a
per-security override or the user default, and take part in the same
primary-then-fallback resolution (`QuoteProviderRegistry`) and the same currency
acceptance check as Yahoo and MSN. `QUOTE_PROVIDER_NAMES` is the single source of
truth the DTO validators and the `quote_provider` / `default_quote_provider`
CHECK constraints read.

The retrieval mechanics were reconstructed from captured browser traffic of each
venue's own price-history page; neither venue publishes a documented public API,
so section 4 records the operational caveats honestly.

## 2. London Stock Exchange (`lse`)

`backend/src/securities/lse-finance.service.ts`. Addressed by TIDM (e.g.
`AGGU`). The LSE company page serves its chart from a third-party widget backend
(financial.com, an LSEG partner). The chain, all through the circuit breaker:

1. Build the Reuters Instrument Code as `<TIDM>.L` (the LSE convention).
2. `GET api.londonstockexchange.com/api/gw/feedhandler/token/saml` -> a SAML
   artifact (`encodedToken`), sent with the page's own `Origin`/`Referer`.
3. `POST refinitiv-widgets.financial.com/auth/api/v1/sessions/samllogin` with
   `SAMLResponse=<encodedToken>` -> a short-lived session JWT (~5 min), cached
   until shortly before it expires.
4. `GET refinitiv-widgets.financial.com/rest/api/timeseries/historical` with
   `ric`, `fromDate`, `toDate`, `fids=_DATE_END,CLOSE_PRC,HIGH_1,OPEN_PRC,LOW_1`,
   `samples=D`, and the JWT in a `jwt:` header -> daily OHLC rows.

The endpoint is windowed, so `fetchHistoricalWindowSeries` is native and
`fetchHistoricalSeries` maps a named range onto a window. A `CLOSE_PRC` of `"-"`
is a session with no trade (holiday/halt) and is dropped, never stored as a
zero. No credentials of the reader's are used; the server replays the whole
chain.

## 3. Deutsche Börse / Börse Frankfurt (`deutsche_boerse`)

`backend/src/securities/deutsche-boerse-finance.service.ts`. Addressed by ISIN
(e.g. `IE00B6R52259`). Börse Frankfurt streams daily history over a websocket
rather than a REST endpoint:

1. `GET api.live.deutsche-boerse.com/v1/mdstokenservice/token` (see section 4)
   -> a market-data token (JWT, scope `websocket`, ~7 min).
2. Open `wss://api.live.deutsche-boerse.com/v1/mds/ws`, authenticate with
   `subscribeAuthentication`, then send `listTimeseries` with `resolution:"1D"`
   and a `marketstateId` of `DELAYED[<isin>,<ccy>@ETR>STX]` (Xetra).
3. Collect the streamed `dataTimeseries` frames (date/open/high/low/close/
   quantity) until the stream goes idle, then close.

The websocket is Node's built-in `WebSocket` (no new dependency) behind an
injectable factory for testing, and the token fetch is gated by the same breaker
as every other outbound call.

## 4. Missing-data policy and the Deutsche Börse caveat

- **Currency is read from the instrument, not guessed from the exchange.** The
  LSE series carries no currency, so it is read from
  `instruments/alldata/<tidm>` (`currency`); the Börse Frankfurt series takes it
  from `/v1/data/currency?isin=`. The `HistoricalSeries.currencyCode` carries it
  to the acceptance point, where `verifyProviderCurrency` refuses a payload whose
  currency is not the security's (INV-PRICE-001). GBX/GBp is divided into pounds
  and reported as GBP, like the other providers.
- **A refused or unreachable upstream returns `null` (no answer), never a
  substituted figure.** An empty window returns a series with no bars.
- **The Börse Frankfurt token endpoint is guarded by an `x-security` request
  signature the site computes from a rotating client secret embedded in its own
  JavaScript.** That secret is not in the captured traffic and is not ours to
  ship. It is supplied out of band through `DEUTSCHE_BOERSE_SECURITY_SALT`
  (documented in `.env.example`), and the signature is `md5(salt + traceId)`,
  the scheme observed in the traffic. While the salt is unset the provider
  reports no data rather than issuing a request the endpoint would reject, and
  the value must be refreshed when the endpoint begins returning 401. This is a
  known fragility, recorded here rather than hidden: a maintainer must weigh the
  venue's terms of use before relying on it.

## 5. Test matrix

- `lse-finance.service.spec.ts`, `deutsche-boerse-finance.service.spec.ts`:
  quote mapping, windowed OHLC, GBX conversion, the `"-"` / null-close skip,
  currency sourced separately, token caching and expiry, degraded upstreams
  (SAML failure, token failure, unknown currency, socket error), range mapping,
  ISIN validation.
- `quote-provider.registry.spec.ts`: resolution and fallback ordering across all
  four providers.
- `provider-call.guard.spec.ts`: both new services route their outbound calls
  through the breaker and are registered guarded clients.
- Migration `20260924075958_widen_quote_provider_check.sql` widens both CHECK
  constraints; `database/schema.sql` and the integration baseline are updated in
  the same change.
