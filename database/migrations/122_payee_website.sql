-- Website for a payee.
--
-- The payee detail page is where you go to remember who a payee actually is,
-- and for most of them the answer is a company with a site: the shop's opening
-- hours, the utility's billing portal, the subscription's cancel page. Storing
-- it turns the payee record into the place that link lives, instead of a
-- bookmark somewhere else.
--
-- Entered without a scheme it is stored as https (see
-- backend/src/common/normalize-website.ts); an explicit http:// is kept,
-- because someone who typed it usually did so for a host that serves nothing
-- else. Width matches the other URL columns in the schema (institutions.website,
-- securities.website, security_documents.url).

ALTER TABLE payees ADD COLUMN IF NOT EXISTS website VARCHAR(2048);
