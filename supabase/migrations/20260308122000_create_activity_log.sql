-- Create activity_log table for notifications and audit trail
CREATE TABLE IF NOT EXISTS public.activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their own activity logs"
    ON public.activity_log
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own activity logs"
    ON public.activity_log
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "System can insert activity logs"
    ON public.activity_log
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS activity_log_user_id_created_at_idx ON public.activity_log(user_id, created_at DESC);
