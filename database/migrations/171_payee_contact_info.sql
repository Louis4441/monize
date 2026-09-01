-- Contact information for payees: a free-text address, an email and a phone
-- number, plus the coordinates the address resolves to.
--
-- The address is one free-text field rather than structured parts: users paste
-- what they have, formats are locale-specific, and the only machine consumer is
-- a geocoder that accepts a single query string anyway.
--
-- latitude/longitude are resolved server-side (Nominatim) so the browser never
-- contacts a third party, the same reason the payee favicon is fetched by the
-- backend. geocoded_at stamps the ATTEMPT, successful or not -- mirroring
-- logo_fetched_at -- which is what distinguishes the three states a reader
-- needs to tell apart:
--   geocoded_at IS NULL                       -> never looked up (no address, or cleared)
--   geocoded_at NOT NULL AND latitude IS NULL -> looked up, nothing found
--   latitude NOT NULL                         -> located, map renders
-- Without the timestamp, "no coordinates" would collapse the first two into one
-- state and the UI could not tell "not tried yet" from "tried and failed".
--
-- NUMERIC(9,6) holds +/-180.000000 at ~11cm resolution, which is far finer than
-- a street address is meaningful to; one width serves both columns.

ALTER TABLE payees ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE payees ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE payees ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE payees ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6);
ALTER TABLE payees ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);
ALTER TABLE payees ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMP;
