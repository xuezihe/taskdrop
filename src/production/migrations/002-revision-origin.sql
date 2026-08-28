ALTER TABLE revisions
  ADD COLUMN origin text;

UPDATE revisions
   SET origin = 'mcp'
 WHERE origin IS NULL;

ALTER TABLE revisions
  ALTER COLUMN origin SET NOT NULL,
  ADD CONSTRAINT revisions_origin_allowed
    CHECK (origin IN ('mcp', 'human', 'webmcp'));
