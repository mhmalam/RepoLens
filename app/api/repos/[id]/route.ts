import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { guardedPump } from "@/lib/ingest";

export const maxDuration = 300;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { data, error } = await db()
    .from("repos")
    .select(
      "id,owner,name,default_branch,commit_sha,file_count,chunk_count,indexed_files,status,error,created_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  // Polling doubles as the engine that resumes quota-paced embedding.
  if (data.status === "indexing") {
    after(() => guardedPump(data.id).catch(() => {}));
  }
  return NextResponse.json(data);
}
