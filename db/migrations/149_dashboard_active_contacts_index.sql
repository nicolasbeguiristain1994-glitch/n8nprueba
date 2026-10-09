-- migrate: nontransactional
-- Serve exact active-contact counts and recent-contact lists from a narrow index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_active_created
  ON public.contacts (created_at DESC)
  WHERE deleted_at IS NULL;
