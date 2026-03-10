-- Add tracking columns to purchaseorders table
ALTER TABLE purchaseorders 
ADD COLUMN tracking_number TEXT,
ADD COLUMN courier TEXT,
ADD COLUMN tracking_status TEXT DEFAULT 'pending';

-- Create an index for tracking search if needed
CREATE INDEX idx_purchaseorders_tracking_number ON purchaseorders(tracking_number);
