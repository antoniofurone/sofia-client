-- Sofia Client — migration 002
-- Adds app_name and caller_user_id to sf_app_tokens.
--
-- app_name        : the authenticating app (mirrors sf_user.app_name)
-- caller_user_id  : the end-user in the calling app (NOT a FK — external identity)
--
-- Run once:
--   psql -d <dbname> -f server/migrations/002_add_caller_to_app_tokens.sql

ALTER TABLE sf_app_tokens ADD COLUMN IF NOT EXISTS app_name       TEXT;
ALTER TABLE sf_app_tokens ADD COLUMN IF NOT EXISTS caller_user_id TEXT;

-- grant accesso to agents
select * from sf_agents_config;

insert into sf_user(user_id,pwd_hash,type,active) values ('NS293854','','user',false);

INSERT INTO "public"."sf_agents_access" ("agent_name", "user_id", "profile") VALUES ('sofia-admin', 'NS293854', '{"role": "user"}'::jsonb);
INSERT INTO "public"."sf_agents_access" ("agent_name", "user_id", "profile") VALUES ('sofia-monitoring', 'NS293854', '{"role": "user"}'::jsonb);
INSERT INTO "public"."sf_agents_access" ("agent_name", "user_id", "profile") VALUES ('sofia-api-keys', 'NS293854', '{"role": "user"}'::jsonb);
INSERT INTO "public"."sf_agents_access" ("agent_name", "user_id", "profile") VALUES ('sofia-redis', 'NS293854', '{"role": "user"}'::jsonb);
INSERT INTO "public"."sf_agents_access" ("agent_name", "user_id", "profile") VALUES ('invoices-ame', 'NS293854', '{"role": "user"}'::jsonb);

select * from sf_user;

select * from sf_agents_access;

-- Generate INSERT statements for existing sf_user rows (for reference)
SELECT
  'INSERT INTO public.sf_api_keys (' || cols.col_list || ') VALUES (' || vals.val_list || ');'
FROM public.sf_api_keys t
CROSS JOIN LATERAL (
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS col_list
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sf_api_keys'
) cols
CROSS JOIN LATERAL (
  SELECT string_agg(
    CASE
      WHEN value IS NULL             THEN 'NULL'
      WHEN data_type = 'jsonb'       THEN quote_literal(value) || '::jsonb'
      WHEN data_type = 'json'        THEN quote_literal(value) || '::json'
      WHEN data_type = 'boolean'     THEN value
      WHEN data_type IN ('integer','bigint','numeric','real','double precision')
                                     THEN value
      -- Array: genera ARRAY['a','b'] tramite subquery scalare
      WHEN data_type = 'ARRAY'       THEN (
        SELECT 'ARRAY[' || string_agg(quote_literal(el), ',') || ']'
        FROM json_array_elements_text(value::json) el
      )
      ELSE quote_literal(value)
    END,
    ', '
    ORDER BY ordinal_position
  ) AS val_list
  FROM json_each_text(row_to_json(t)) j
  JOIN information_schema.columns c
    ON c.column_name = j.key
    AND c.table_schema = 'public'
    AND c.table_name = 'sf_api_keys'
) vals;

-- insert nella sf_agents_config per translator
INSERT INTO
  "public"."sf_agents_config" ( "agent_name",
    "url",
    "api_key" )
VALUES
  ( 'translator', 'https://ag-translator-508683109767.europe-west8.run.app', 'stls_f0444b3160d740d41e179310334092c84a51d92587e2814cc583a1e1da9ffbaa' );