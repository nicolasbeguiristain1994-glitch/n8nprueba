-- Editable destinations for assigned contact lines; unrelated to sending credentials.
CREATE TABLE public.crm_agents (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9_-]*$' AND length(code) <= 100),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.agent_contact_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_code text NOT NULL REFERENCES public.crm_agents(code),
  linea smallint NOT NULL CHECK (linea BETWEEN 1 AND 100),
  variant text NOT NULL DEFAULT '' CHECK (variant IN ('','a','b','c')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_code,linea,variant)
);
-- Custom application sessions authorize the server API. No direct Data API access.
ALTER TABLE public.crm_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_contact_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_agents, public.agent_contact_lines FROM PUBLIC, anon, authenticated;
INSERT INTO public.crm_agents(code,name) VALUES
  ('betcoin','Betcoin'),('bigwin','Bigwin'),('farabet','Farabet'),
  ('ofizeus','Ofizeus'),('royal','Royal'),('lasvegas','Las Vegas');
-- Preserve the verified Ofizeus destinations previously held in code.
INSERT INTO public.agent_contact_lines(agent_code,linea,variant,label,phone) VALUES
  ('ofizeus',1,'','ZEUS 1','+5491125489456'),
  ('ofizeus',1,'a','OFI 1A','+5491164598463'),
  ('ofizeus',2,'','ZEUS 2','+5491125623142'),
  ('ofizeus',3,'','ZEUS 3','+5491154726043'),
  ('ofizeus',3,'a','OFI 3A','+5491124915455'),
  ('ofizeus',4,'','ZEUS 4','+5491125624422'),
  ('ofizeus',4,'a','OFI 4A','+5491154725918'),
  ('ofizeus',5,'','ZEUS 5','+5491178498067'),
  ('ofizeus',5,'a','OFI 5A','+5491164598145'),
  ('ofizeus',6,'','ZEUS 6','+5491125624363'),
  ('ofizeus',7,'','ZEUS 7','+5491125622774'),
  ('ofizeus',8,'','ZEUS 8','+5491160597743'),
  ('ofizeus',8,'a','OFI 8A','+5491140565762'),
  ('ofizeus',9,'','ZEUS 9','+5491125388962'),
  ('ofizeus',9,'a','OFI 9A','+5491162504611'),
  ('ofizeus',10,'','ZEUS 10 VIP','+5491125388755');
