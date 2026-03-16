alter table products
  add column if not exists shopify_bound boolean not null default false;

comment on column products.shopify_bound is 'If true, StockLane may create a Shopify draft for this product when stock is received and no Shopify link exists yet.';
