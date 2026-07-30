-- Documents attached to a security: a factsheet, a KIID, a prospectus, an
-- annual report, a tax slip, a piece of research.
--
-- Real columns rather than a JSONB blob, as the maintainer asked (discussion
-- #964): the type, the name, the document's own date and its address each need
-- to be sortable and filterable, which a JSON array cannot do without scanning
-- every row.
--
-- `document_date` is the date on the document, not the date it was recorded --
-- a 2024 annual report added today sorts under 2024. Nullable, because plenty of
-- documents carry no date and guessing one would be worse than leaving it out.
--
-- Only linked documents for now. Uploading a file here needs the attachments
-- table generalised first: `transaction_attachments.transaction_id` is NOT NULL,
-- so a security cannot own a row in it, and widening that module is its own
-- change rather than a column added here that nothing could fill.

CREATE TABLE IF NOT EXISTS security_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    security_id UUID NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
    document_type VARCHAR(30) NOT NULL DEFAULT 'OTHER',
    name VARCHAR(255) NOT NULL,
    document_date DATE,
    url VARCHAR(2048) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT security_documents_type_check
      CHECK (document_type IN (
        'FACTSHEET','KIID','PROSPECTUS','ANNUAL_REPORT',
        'SEMI_ANNUAL_REPORT','TAX','RESEARCH','OTHER'
      ))
);

-- The list is always read for one security, newest document first.
CREATE INDEX IF NOT EXISTS idx_security_documents_security
  ON security_documents(security_id, document_date DESC NULLS LAST);

-- Every tenant-scoped read filters on user_id.
CREATE INDEX IF NOT EXISTS idx_security_documents_user
  ON security_documents(user_id);
