/**
 * RepoLens eval harness.
 *
 * Runs every golden case through the full pipeline with BOTH router tiers
 * forced (groq fast + gemini smart), scores:
 *   (a) retrieval_hit — must_cite file appeared in the top-8 retrieved chunks
 *   (b) answer_score 0-2 — LLM judge (Gemini Flash) against the case rubric
 * Writes one eval_runs row per model, emits a markdown report, and exits
 * non-zero if a model's pass rate regressed by more than 10 points.
 *
 * Usage: npm run eval
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

// Load .env.local before importing lib modules that read process.env.
const envPath = join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

import { db } from "../lib/db";
import { ingestRepo } from "../lib/ingest";
import { gemini } from "../lib/llm/gemini";
import { groq } from "../lib/llm/groq";
import { Provider } from "../lib/llm/types";
import { buildMessages } from "../lib/prompt";
import { retrieve, CONTEXT_TOP_K } from "../lib/retrieval";

interface GoldenCase {
  repo: string;
  question: string;
  must_cite: string;
  rubric: string;
}

interface CaseResult {
  case: GoldenCase;
  retrievalHit: boolean;
  scores: Record<string, { score: number; reasoning: string }>;
}

const PASS_THRESHOLD = 1; // answer_score >= 1 counts as a pass
const REGRESSION_POINTS = 10;

async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!/\b(429|500|502|503)\b/.test(String(err)) || i === tries - 1) throw err;
      const wait = 5000 * 2 ** i;
      console.log(`  retryable error, waiting ${wait / 1000}s: ${String(err).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function ensureRepoIndexed(fullName: string): Promise<string> {
  const pins = JSON.parse(readFileSync(join(__dirname, "repos.json"), "utf8"));
  const pin = pins[fullName];
  if (!pin) throw new Error(`No pinned SHA for ${fullName} in evals/repos.json`);
  const [owner, name] = fullName.split("/");
  const supabase = db();

  const { data: existing } = await supabase
    .from("repos")
    .select("id,status")
    .eq("owner", owner)
    .eq("name", name)
    .eq("commit_sha", pin.sha)
    .maybeSingle();
  if (existing?.status === "ready") return existing.id;
  if (existing) await supabase.from("repos").delete().eq("id", existing.id);

  console.log(`Ingesting ${fullName}@${pin.sha.slice(0, 7)}…`);
  const { data: repo, error } = await supabase
    .from("repos")
    .insert({
      owner,
      name,
      default_branch: pin.defaultBranch,
      commit_sha: pin.sha,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await ingestRepo(repo.id, {
    owner,
    name,
    defaultBranch: pin.defaultBranch,
    commitSha: pin.sha,
    sizeKb: 0,
  });
  const { data: after } = await supabase
    .from("repos")
    .select("status,error,chunk_count")
    .eq("id", repo.id)
    .single();
  if (after?.status !== "ready") {
    throw new Error(`Ingestion of ${fullName} failed: ${after?.error}`);
  }
  console.log(`  ready — ${after.chunk_count} chunks`);
  return repo.id;
}

const JUDGE_SYSTEM = `You are a strict evaluator of answers about a codebase.
Score the ANSWER against the RUBRIC:
2 = correct and grounded: satisfies the rubric, cites the right file(s)
1 = partially correct: right direction but incomplete, imprecise, or weak citations
0 = wrong, ungrounded, hallucinated, or "not found" when the rubric is satisfiable
Respond with ONLY a JSON object: {"score": 0|1|2, "reasoning": "<one sentence>"}`;

async function judge(c: GoldenCase, answer: string): Promise<{ score: number; reasoning: string }> {
  const { text } = await withRetry(() =>
    gemini.complete(
      [
        { role: "system", content: JUDGE_SYSTEM },
        {
          role: "user",
          content: `QUESTION: ${c.question}\n\nRUBRIC: ${c.rubric}\nEXPECTED CITATION FILE: ${c.must_cite}\n\nANSWER:\n${answer}`,
        },
      ],
      { maxTokens: 200 }
    )
  );
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: 0, reasoning: `unparseable judge output: ${text.slice(0, 80)}` };
  try {
    const json = JSON.parse(m[0]);
    return { score: Math.max(0, Math.min(2, Number(json.score) || 0)), reasoning: json.reasoning ?? "" };
  } catch {
    return { score: 0, reasoning: "unparseable judge JSON" };
  }
}

function isHit(filePath: string, mustCite: string): boolean {
  return filePath === mustCite || filePath.startsWith(mustCite.replace(/\/$/, "") + "/");
}

async function main() {
  const cases: GoldenCase[] = readFileSync(join(__dirname, "golden.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  console.log(`${cases.length} golden cases`);

  const repoIds = new Map<string, string>();
  for (const fullName of [...new Set(cases.map((c) => c.repo))]) {
    repoIds.set(fullName, await ensureRepoIndexed(fullName));
  }

  const models: Provider[] = [groq, gemini];
  const results: CaseResult[] = [];

  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.repo} — ${c.question.slice(0, 60)}… `);
    const repoId = repoIds.get(c.repo)!;
    const chunks = await withRetry(() => retrieve(repoId, c.question));
    const retrievalHit = chunks.some((ch) => isHit(ch.file_path, c.must_cite));
    const messages = buildMessages(c.question, chunks);

    const scores: CaseResult["scores"] = {};
    for (const model of models) {
      const { text } = await withRetry(() => model.complete(messages, { maxTokens: 1200 }));
      scores[`${model.name}/${model.model}`] = await judge(c, text);
    }
    results.push({ case: c, retrievalHit, scores });
    console.log(
      `${retrievalHit ? "hit" : "MISS"} | ` +
        Object.entries(scores).map(([m, s]) => `${m.split("/")[0]}:${s.score}`).join(" ")
    );
  }

  // Aggregate.
  const hitRate = (100 * results.filter((r) => r.retrievalHit).length) / results.length;
  const gitSha =
    process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD").toString().trim();

  const supabase = db();
  const summary: Array<{
    model: string;
    pass: number;
    fail: number;
    avg: number;
    prevPassRate: number | null;
  }> = [];

  let regression = false;
  for (const model of models) {
    const key = `${model.name}/${model.model}`;
    const scores = results.map((r) => r.scores[key].score);
    const pass = scores.filter((s) => s >= PASS_THRESHOLD).length;
    const fail = scores.length - pass;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

    const { data: prev } = await supabase
      .from("eval_runs")
      .select("pass_count,fail_count")
      .eq("model", key)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const prevPassRate = prev ? (100 * prev.pass_count) / (prev.pass_count + prev.fail_count) : null;
    const passRate = (100 * pass) / scores.length;
    if (prevPassRate !== null && passRate < prevPassRate - REGRESSION_POINTS) regression = true;

    await supabase.from("eval_runs").insert({
      git_sha: gitSha,
      model: key,
      pass_count: pass,
      fail_count: fail,
      avg_score: avg.toFixed(2),
      retrieval_hit_rate: hitRate.toFixed(2),
    });
    summary.push({ model: key, pass, fail, avg, prevPassRate });
  }

  // Markdown report.
  const lines: string[] = [];
  lines.push(`# Eval report — \`${gitSha.slice(0, 7)}\``);
  lines.push("");
  lines.push(`**${results.length} cases · retrieval hit rate: ${hitRate.toFixed(1)}%** (must_cite in top-${CONTEXT_TOP_K})`);
  lines.push("");
  lines.push("| model | pass | fail | pass rate | avg score (0-2) | prev pass rate |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of summary) {
    const rate = (100 * s.pass) / (s.pass + s.fail);
    lines.push(
      `| \`${s.model}\` | ${s.pass} | ${s.fail} | ${rate.toFixed(1)}% | ${s.avg.toFixed(2)} | ${
        s.prevPassRate !== null ? s.prevPassRate.toFixed(1) + "%" : "—"
      } |`
    );
  }
  const misses = results.filter((r) => !r.retrievalHit);
  if (misses.length) {
    lines.push("");
    lines.push("## Retrieval misses");
    for (const m of misses) lines.push(`- ${m.case.repo}: "${m.case.question}" (wanted \`${m.case.must_cite}\`)`);
  }
  const lowScores = results.filter((r) => Object.values(r.scores).some((s) => s.score === 0));
  if (lowScores.length) {
    lines.push("");
    lines.push("## Zero-score answers");
    for (const r of lowScores) {
      for (const [model, s] of Object.entries(r.scores)) {
        if (s.score === 0) lines.push(`- [${model}] ${r.case.repo}: "${r.case.question}" — ${s.reasoning}`);
      }
    }
  }
  if (regression) {
    lines.push("");
    lines.push(`> ❌ **REGRESSION**: pass rate dropped more than ${REGRESSION_POINTS} points vs the previous run.`);
  }
  const report = lines.join("\n");

  writeFileSync(join(__dirname, "report.md"), report + "\n");
  console.log("\n" + report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  }

  if (regression) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
