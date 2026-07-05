import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set");
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

export interface RepoRow {
  id: string;
  owner: string;
  name: string;
  default_branch: string;
  commit_sha: string;
  file_count: number;
  chunk_count: number;
  indexed_files: number;
  status: "pending" | "indexing" | "ready" | "failed";
  error: string | null;
  created_at: string;
}

export interface ChunkRow {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  content: string;
  similarity: number;
}
