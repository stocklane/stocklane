# Supabase User Migration

This project includes a tenant migration script for moving one user's data from one Supabase project to another.

## What it migrates

- `profiles`
- `user_settings`
- `folders`
- `suppliers`
- `products`
- `purchaseorders`
- `polines`
- `inventory`
- `transit`
- `invoices`
- `tasks`
- `shopify_orders`
- `order_inventory_effects`
- `activity_log`
- `product_integrations`
- Purchase order invoice files from the `po-invoices` storage bucket

## Before you run it

1. Make sure the target Supabase project has the same schema as production.
2. Make sure the target auth user already exists in `auth.users`.
3. Make sure the target project has a `po-invoices` storage bucket if you want invoice images copied.
4. If the target project was created only from repo migrations, double-check that the `folders` table exists. This repo currently uses it, but there is no matching migration file in `supabase/migrations`.

## Environment variables

Put these in `.env.local`:

```bash
OLD_SUPABASE_URL=https://old-project.supabase.co
OLD_SUPABASE_SERVICE_ROLE_KEY=old-service-role-key
OLD_SUPABASE_USER_ID=old-auth-user-id

NEW_SUPABASE_URL=https://new-project.supabase.co
NEW_SUPABASE_SERVICE_ROLE_KEY=new-service-role-key
NEW_SUPABASE_USER_ID=new-auth-user-id

# Optional
SUPABASE_MIGRATION_BUCKET=po-invoices
```

The script also accepts existing app env names for the target project:

- `SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Run it

Dry run first:

```bash
npm run supabase:migrate-user -- --dry-run
```

Run the migration:

```bash
npm run supabase:migrate-user
```

If you need to wipe the target user's current rows before copying:

```bash
npm run supabase:migrate-user -- --reset-target
```

If you want to skip storage copy:

```bash
npm run supabase:migrate-user -- --skip-storage
```

## Notes

- The script rewrites `purchaseorders.imageurl` and `purchaseorders.imageurls` to the new Supabase project URL.
- It only clears rows for the target user when `--reset-target` is set.
- It does not migrate Supabase Auth users between projects; create the destination user first.
