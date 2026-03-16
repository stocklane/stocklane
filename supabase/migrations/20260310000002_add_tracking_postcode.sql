-- Add tracking postcode column to purchaseorders table
ALTER TABLE purchaseorders 
ADD COLUMN tracking_postcode TEXT;
