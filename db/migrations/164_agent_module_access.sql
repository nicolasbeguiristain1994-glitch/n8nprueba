-- Backward-compatible grants: Prioridades used to be part of Contactos.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
UPDATE public.users SET sectors=sectors || '["priorities"]'::jsonb
  WHERE sectors ? 'contacts' AND NOT sectors ? 'priorities';
-- A former administrator must not keep the infrastructure bypass after demotion.
UPDATE public.users SET is_super_admin=false WHERE role<>'admin' AND is_super_admin=true;
ALTER TABLE public.automation_logs ADD COLUMN agent_code text;
-- Historical logs with no trustworthy attribution remain administrative only.
CREATE OR REPLACE FUNCTION public.get_accessible_line_ids(p_user_id uuid)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE v_role text; v_is_super boolean;
BEGIN
  SELECT role::text,is_super_admin INTO v_role,v_is_super FROM users WHERE id=p_user_id AND is_active=true;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_role='admin' AND v_is_super THEN
    RETURN QUERY SELECT id FROM whatsapp_lines; RETURN;
  END IF;
  IF v_role='admin' THEN
    RETURN QUERY WITH my_operators AS (SELECT id FROM users WHERE manager_id=p_user_id AND is_active=true)
      SELECT DISTINCT wl.id FROM whatsapp_lines wl
      WHERE wl.owner_user_id=p_user_id OR wl.owner_user_id IN (SELECT id FROM my_operators)
        OR wl.owner_user_id IS NULL OR EXISTS(SELECT 1 FROM line_grants lg WHERE lg.line_id=wl.id
          AND (lg.granted_to=p_user_id OR lg.granted_to IN (SELECT id FROM my_operators)));
    RETURN;
  END IF;
  RETURN QUERY SELECT DISTINCT wl.id FROM whatsapp_lines wl WHERE wl.owner_user_id=p_user_id
    OR EXISTS(SELECT 1 FROM line_grants lg WHERE lg.line_id=wl.id AND lg.granted_to=p_user_id);
END;
$$;
