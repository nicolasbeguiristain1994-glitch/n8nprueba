-- Priority broadcasts use the existing durable campaign queue and a frozen audience.
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS is_priority_broadcast boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.priority_broadcasts (
  campaign_id uuid PRIMARY KEY REFERENCES public.campaigns(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK(length(request_hash)=64),
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.priority_broadcasts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.priority_broadcasts FROM PUBLIC;
ALTER TABLE public.contact_priority_scores ADD COLUMN IF NOT EXISTS broadcast_campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL;

-- The message and its management flag commit together, including webhook failures.
-- Only transitions into confirmed states mark a contact; later delivery/read events
-- must not undo an operator's deliberate return to the pending list.
CREATE OR REPLACE FUNCTION public.sync_priority_broadcast_message() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE actor text;
BEGIN
  IF NEW.direction <> 'outbound' OR NEW.contact_id IS NULL OR NEW.campaign_id IS NULL THEN RETURN NEW; END IF;
  SELECT actor_name INTO actor FROM public.priority_broadcasts WHERE campaign_id=NEW.campaign_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.status IN ('sent','delivered','read') AND
     (TG_OP='INSERT' OR OLD.status NOT IN ('sent','delivered','read')) THEN
    UPDATE public.contact_priority_scores SET is_broadcasted=true,
      broadcasted_at=COALESCE(NEW.sent_at,now()),broadcasted_by=actor,broadcast_campaign_id=NEW.campaign_id
    WHERE contact_id=NEW.contact_id AND is_broadcasted=false;
  ELSIF NEW.status='failed' AND TG_OP='UPDATE' AND OLD.status IN ('sent','delivered','read') THEN
    UPDATE public.contact_priority_scores cps SET is_broadcasted=false,
      broadcasted_at=NULL,broadcasted_by=NULL,broadcast_campaign_id=NULL
    WHERE cps.contact_id=NEW.contact_id AND cps.broadcast_campaign_id=NEW.campaign_id
      AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages wm WHERE wm.campaign_id=NEW.campaign_id
        AND wm.contact_id=NEW.contact_id AND wm.id<>NEW.id AND wm.direction='outbound'
        AND wm.status IN ('sent','delivered','read'));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priority_broadcast_message ON public.whatsapp_messages;
CREATE TRIGGER priority_broadcast_message AFTER INSERT OR UPDATE OF status ON public.whatsapp_messages
FOR EACH ROW EXECUTE FUNCTION public.sync_priority_broadcast_message();
