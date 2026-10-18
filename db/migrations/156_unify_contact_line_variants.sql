-- A/B/C destinations were retired by the operator. Keep the base line and all
-- contact/account identities. The old columns remain for rolling deployments.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.agent_contact_lines IN SHARE ROW EXCLUSIVE MODE;

-- If an installation has no base, keep its only unambiguous destination. Never
-- silently choose between different variant-only phone/link configurations.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agent_contact_lines v
    WHERE NOT EXISTS (SELECT 1 FROM public.agent_contact_lines b
      WHERE b.agent_code=v.agent_code AND b.linea=v.linea AND b.variant='')
    GROUP BY v.agent_code,v.linea
    HAVING count(DISTINCT (v.label,v.phone,v.link_url,v.is_active)) > 1
  ) THEN RAISE EXCEPTION 'Conflicting variant-only destinations: configure a base line before unifying'; END IF;
END $$;
UPDATE public.agent_contact_lines SET variant=''
WHERE id IN (
  SELECT DISTINCT ON (v.agent_code,v.linea) v.id FROM public.agent_contact_lines v
  WHERE NOT EXISTS (SELECT 1 FROM public.agent_contact_lines b
    WHERE b.agent_code=v.agent_code AND b.linea=v.linea AND b.variant='')
  ORDER BY v.agent_code,v.linea,v.variant
);
DELETE FROM public.agent_contact_lines WHERE variant<>'';
ALTER TABLE public.agent_contact_lines ADD CONSTRAINT agent_contact_lines_base_only CHECK (variant='');

-- Imports and still-open older clients may continue to provide a letter.
-- Normalize that field at the database boundary without changing the number.
CREATE FUNCTION public.normalize_contact_base_line() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  NEW.linea_sub := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.normalize_contact_base_line() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER trg_contacts_base_line BEFORE INSERT OR UPDATE OF linea,linea_sub
ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.normalize_contact_base_line();
UPDATE public.contacts SET linea_sub=NULL WHERE linea_sub IS NOT NULL;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_base_line_only CHECK (linea_sub IS NULL);
