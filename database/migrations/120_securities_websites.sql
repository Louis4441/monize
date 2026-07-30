-- Website and investor-relations address for a security.
--
-- The detail page has laid out both rows since it was built, showing "not stored
-- yet" because there was nowhere to keep them. Now there is.
--
-- Only `website` can be filled automatically. Yahoo returns it in the
-- `summaryProfile` module that the "Fetch from Yahoo" pre-fill already requests,
-- so reading it costs no extra call -- though it is populated for shares and
-- usually absent for ETFs and funds, where the provider gives a fund family and
-- no URL. Neither Yahoo nor MSN publishes an investor-relations address at all,
-- so `ir_website` is manual by nature; guessing it by appending /investors to a
-- domain would produce a link that mostly 404s, and a wrong link is worse than
-- an empty field.
--
-- Width matches the other URL columns in the schema (institutions.website,
-- security_documents.url).

ALTER TABLE securities ADD COLUMN IF NOT EXISTS website VARCHAR(2048);
ALTER TABLE securities ADD COLUMN IF NOT EXISTS ir_website VARCHAR(2048);
