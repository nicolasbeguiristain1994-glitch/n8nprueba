-- Keep user identities for historical ownership and audit references.
ALTER TABLE public.users
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT users_deleted_inactive CHECK (deleted_at IS NULL OR is_active = false);
