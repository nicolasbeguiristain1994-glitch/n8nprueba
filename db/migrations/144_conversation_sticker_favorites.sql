-- Favorites are private to the application user; only the authenticated server API accesses them.
CREATE TABLE public.conversation_sticker_favorites (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 24),
  digest text NOT NULL CHECK (length(digest)=64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  data_uri text NOT NULL CHECK (length(data_uri)<=700000 AND data_uri LIKE 'data:image/webp;base64,%'),
  preview text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot),
  UNIQUE (user_id, digest)
);
ALTER TABLE public.conversation_sticker_favorites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_sticker_favorites FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.conversation_sticker_favorites FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.conversation_sticker_favorites FROM authenticated;
  END IF;
END $$;
