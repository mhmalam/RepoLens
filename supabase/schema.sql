-- RepoLens schema — run in the Supabase SQL editor.
create extension if not exists vector;

create table if not exists repos (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  name text not null,
  default_branch text not null,
  commit_sha text not null,
  file_count int not null default 0,
  chunk_count int not null default 0,
  indexed_files int not null default 0,
  status text not null default 'pending' check (status in ('pending','indexing','ready','failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (owner, name, commit_sha)
);

create table if not exists chunks (
  id bigint generated always as identity primary key,
  repo_id uuid not null references repos(id) on delete cascade,
  file_path text not null,
  start_line int not null,
  end_line int not null,
  language text not null,
  content text not null,
  embedding vector(768)
);

create index if not exists chunks_repo_id_idx on chunks (repo_id);
create index if not exists chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);

create table if not exists queries (
  id bigint generated always as identity primary key,
  repo_id uuid references repos(id) on delete set null,
  question text not null,
  model_used text not null,
  route_reason text not null,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  latency_ms int not null default 0,
  retrieval_ids bigint[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists eval_runs (
  id bigint generated always as identity primary key,
  git_sha text not null,
  model text not null,
  pass_count int not null default 0,
  fail_count int not null default 0,
  avg_score numeric(4,2) not null default 0,
  retrieval_hit_rate numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);

-- Cosine-similarity search scoped to one repo.
create or replace function match_chunks(
  p_repo_id uuid,
  p_query_embedding vector(768),
  p_match_count int default 20
)
returns table (
  id bigint,
  file_path text,
  start_line int,
  end_line int,
  language text,
  content text,
  similarity float
)
language sql stable as $$
  select c.id, c.file_path, c.start_line, c.end_line, c.language, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from chunks c
  where c.repo_id = p_repo_id
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;
