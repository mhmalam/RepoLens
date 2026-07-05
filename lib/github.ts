import { gunzipSync } from "zlib";
import { extract } from "tar-stream";
import { Readable } from "stream";

const API = "https://api.github.com";

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repolens",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

export function parseRepoUrl(input: string): { owner: string; name: string } {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = trimmed.match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error("Could not parse a GitHub repo from that URL");
  return { owner: m[1], name: m[2] };
}

export interface RepoMeta {
  owner: string;
  name: string;
  defaultBranch: string;
  commitSha: string;
  sizeKb: number;
}

export async function fetchRepoMeta(owner: string, name: string): Promise<RepoMeta> {
  const res = await fetch(`${API}/repos/${owner}/${name}`, { headers: ghHeaders() });
  if (res.status === 404) throw new Error("Repo not found (is it public?)");
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const repo = await res.json();
  const branchRes = await fetch(
    `${API}/repos/${owner}/${name}/branches/${encodeURIComponent(repo.default_branch)}`,
    { headers: ghHeaders() }
  );
  if (!branchRes.ok) throw new Error(`GitHub API error resolving branch: ${branchRes.status}`);
  const branch = await branchRes.json();
  return {
    owner,
    name,
    defaultBranch: repo.default_branch,
    commitSha: branch.commit.sha,
    sizeKb: repo.size,
  };
}

export const MAX_TARBALL_BYTES = 40 * 1024 * 1024;
export const MAX_INDEXABLE_FILES = 3000;

const SKIP_DIRS =
  /(^|\/)(node_modules|dist|build|out|vendor|\.git|\.next|coverage|__pycache__|\.venv|venv|target|\.idea|\.vscode|fixtures?|snapshots?|__snapshots__)(\/|$)/;
const SKIP_FILES =
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|\.min\.(js|css)|\.map)$/i;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|svg|pdf|zip|gz|tar|br|woff2?|ttf|otf|eot|mp[34]|webm|mov|avi|wasm|exe|dll|so|dylib|class|jar|pyc|db|sqlite|bin|dat|onnx|pt|pb|npz|parquet)$/i;

export function isIndexable(path: string, size: number): boolean {
  if (size === 0 || size > 512 * 1024) return false;
  if (SKIP_DIRS.test(path)) return false;
  if (SKIP_FILES.test(path)) return false;
  if (BINARY_EXT.test(path)) return false;
  return true;
}

export interface RepoFile {
  path: string;
  content: string;
}

/** Download the tarball at a specific commit and extract text files in memory. */
export async function downloadRepoFiles(
  owner: string,
  name: string,
  ref: string
): Promise<RepoFile[]> {
  const res = await fetch(`${API}/repos/${owner}/${name}/tarball/${ref}`, {
    headers: ghHeaders(),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Tarball download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_TARBALL_BYTES) {
    throw new Error(`Repo tarball too large (${Math.round(buf.byteLength / 1e6)}MB > 40MB limit)`);
  }
  const tar = gunzipSync(buf);

  const files: RepoFile[] = [];
  await new Promise<void>((resolve, reject) => {
    const ex = extract();
    ex.on("entry", (header, stream, next) => {
      // Tarball entries are prefixed with "{owner}-{repo}-{sha}/".
      const path = header.name.split("/").slice(1).join("/");
      if (header.type !== "file" || !isIndexable(path, header.size ?? 0)) {
        stream.resume();
        stream.on("end", next);
        return;
      }
      const parts: Buffer[] = [];
      stream.on("data", (d: Buffer) => parts.push(d));
      stream.on("end", () => {
        const content = Buffer.concat(parts);
        // Skip files that are binary despite their extension.
        if (!content.subarray(0, 8000).includes(0)) {
          files.push({ path, content: content.toString("utf8") });
        }
        next();
      });
      stream.on("error", reject);
    });
    ex.on("finish", () => resolve());
    ex.on("error", reject);
    Readable.from(tar).pipe(ex);
  });

  if (files.length > MAX_INDEXABLE_FILES) {
    throw new Error(`Too many indexable files (${files.length} > ${MAX_INDEXABLE_FILES})`);
  }
  return files;
}

export function deepLink(
  owner: string,
  name: string,
  sha: string,
  path: string,
  start: number,
  end: number
): string {
  return `https://github.com/${owner}/${name}/blob/${sha}/${path}#L${start}-L${end}`;
}
