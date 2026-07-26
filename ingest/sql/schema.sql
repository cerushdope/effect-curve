-- schema.sql — run once in the Supabase SQL editor BEFORE the first ingest.
--
-- The existing search_substances() was written for 12 dummy rows. After ingest
-- the table holds a few thousand real drugs with tens of thousands of aliases,
-- and search has to (a) stay fast and (b) rank an exact brand-name hit above a
-- fuzzy one. Typing "Elvanse" must land on lisdexamfetamine, not on whatever
-- shares the most trigrams with it.

create extension if not exists pg_trgm;

-- Ranking helper. Trigram index on the display name; the alias match below is a
-- scan over unnest(), which is comfortably fast at this row count.
create index if not exists substances_name_trgm
  on public.substances using gin (lower(name) gin_trgm_ops);

create index if not exists substances_category_idx
  on public.substances (category);

create or replace function public.search_substances(q text)
returns table (id text, name text, category text, aliases text[])
language sql
stable
as $$
  with needle as (
    select lower(btrim(coalesce(q, ''))) as n
  )
  select s.id, s.name, s.category, s.aliases
  from public.substances s, needle
  where
    needle.n = ''
    or lower(s.name) like '%' || needle.n || '%'
    or exists (
      select 1 from unnest(coalesce(s.aliases, '{}')) a
      where lower(a) like '%' || needle.n || '%'
    )
    -- Trigram similarity catches typos the LIKE branches miss.
    or lower(s.name) % needle.n
  order by
    case
      when needle.n = '' then 5
      when lower(s.name) = needle.n then 0                                   -- exact name
      when exists (select 1 from unnest(coalesce(s.aliases,'{}')) a
                   where lower(a) = needle.n) then 1                          -- exact alias (Elvanse)
      when lower(s.name) like needle.n || '%' then 2                          -- name prefix
      when exists (select 1 from unnest(coalesce(s.aliases,'{}')) a
                   where lower(a) like needle.n || '%') then 3                -- alias prefix
      else 4
    end,
    similarity(lower(s.name), needle.n) desc,
    s.name
  limit 25;
$$;

-- Row-level security: public read only. The ingest job writes with the
-- service_role key, which bypasses RLS.
alter table public.substances enable row level security;

drop policy if exists "public read" on public.substances;
create policy "public read" on public.substances for select to anon using (true);

grant select on table public.substances to anon;
grant execute on function public.search_substances(text) to anon;
