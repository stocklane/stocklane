ALTER TABLE products
ADD COLUMN IF NOT EXISTS folderid UUID REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_folderid ON products(folderid);

UPDATE products AS p
SET folderid = f.id
FROM folders AS f
WHERE p.user_id = f.user_id
  AND p.folderid IS NULL
  AND p.category IS NOT NULL
  AND lower(trim(p.category)) = lower(trim(f.name));
