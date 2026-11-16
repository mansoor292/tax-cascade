-- Single-member LLC with no election, held as its own entity (owner decision
-- 2026-11-16): form type 'SchC' (it files a Schedule C on its owner's 1040),
-- entity type 'disregarded_llc'. Linked to the owner's 1040 by an entity_link
-- of kind 'disregarded'.
ALTER TABLE public.tax_entity DROP CONSTRAINT IF EXISTS tax_entity_form_type_check;
ALTER TABLE public.tax_entity ADD CONSTRAINT tax_entity_form_type_check
  CHECK (form_type = ANY (ARRAY['1120'::text, '1120S'::text, '1040'::text, '1065'::text, 'SchC'::text]));
ALTER TABLE public.tax_entity DROP CONSTRAINT IF EXISTS tax_entity_entity_type_check;
ALTER TABLE public.tax_entity ADD CONSTRAINT tax_entity_entity_type_check
  CHECK (entity_type = ANY (ARRAY['c_corp'::text, 's_corp'::text, 'individual'::text, 'partnership'::text, 'disregarded_llc'::text]));
