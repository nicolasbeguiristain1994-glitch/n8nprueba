-- Shared inbox acknowledgements. Provider message IDs remain stable across the
-- Cloud/legacy mirrors; messages without one use their stored UUID instead.
-- This does not alter message delivery status or send a WhatsApp read receipt.
CREATE TABLE public.conversation_message_views (
  message_key text PRIMARY KEY CHECK (length(message_key) BETWEEN 1 AND 512),
  viewed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.conversation_message_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_message_views FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.conversation_message_views FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.conversation_message_views FROM authenticated;
  END IF;
END $$;
