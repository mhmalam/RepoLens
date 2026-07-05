import { deepLink } from "./github";

export interface Citation {
  raw: string;
  filePath: string;
  startLine: number;
  endLine: number;
  url: string;
}

const CITE_RE = /\[([\w~$@][\w./~$@-]*):L(\d+)(?:-L?(\d+))?\]/g;

/** Extract [path:Lstart-Lend] citations and resolve them to GitHub deep links. */
export function extractCitations(
  answer: string,
  repo: { owner: string; name: string; commit_sha: string }
): Citation[] {
  const seen = new Map<string, Citation>();
  for (const m of answer.matchAll(CITE_RE)) {
    const [raw, filePath, startStr, endStr] = m;
    const startLine = parseInt(startStr, 10);
    const endLine = endStr ? parseInt(endStr, 10) : startLine;
    if (!seen.has(raw)) {
      seen.set(raw, {
        raw,
        filePath,
        startLine,
        endLine,
        url: deepLink(repo.owner, repo.name, repo.commit_sha, filePath, startLine, endLine),
      });
    }
  }
  return [...seen.values()];
}
