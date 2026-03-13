-- StockLane <-> Shopify product linking + pricing automation settings

create table if not exists product_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  platform text not null,
  external_product_id text not null,
  external_variant_id text null,
  external_inventory_item_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_product_id, external_variant_id)
);

alter table product_integrations
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists idx_product_integrations_product_id
  on product_integrations(product_id);
create index if not exists idx_product_integrations_platform
  on product_integrations(platform);
create index if not exists idx_product_integrations_user_id
  on product_integrations(user_id);

alter table product_integrations enable row level security;

drop policy if exists "Users can only see their own product integrations" on product_integrations;
create policy "Users can only see their own product integrations" on product_integrations
  for all using (auth.uid() = user_id);

alter table products
  add column if not exists pricing_greenlight boolean not null default false,
  add column if not exists target_margin numeric null,
  add column if not exists pricing_sales_tax_pct numeric not null default 0,
  add column if not exists pricing_shopify_fee_pct numeric not null default 0,
  add column if not exists pricing_postage_packaging_gbp numeric not null default 0;

comment on column products.pricing_greenlight is 'If true, receiving stock can auto-push a recalculated Shopify price.';
comment on column products.target_margin is 'Target margin percent for price calculation (0-100).';
comment on column products.pricing_sales_tax_pct is 'Sales tax percent used in margin-based selling price calculations.';
comment on column products.pricing_shopify_fee_pct is 'Shopify/platform fee percent used in margin-based selling price calculations.';
comment on column products.pricing_postage_packaging_gbp is 'Per-unit postage and packaging cost in GBP for margin calculations.';
