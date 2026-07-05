export interface Chunk {
  filePath: string;
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
  language: string;
  content: string;
}

const TARGET_MIN = 60;
const TARGET_MAX = 120;
const OVERLAP = 10;

type Family = "jsts" | "python" | "go" | "java" | "generic";

const EXT_LANG: Record<string, { lang: string; family: Family }> = {
  ts: { lang: "typescript", family: "jsts" },
  tsx: { lang: "typescript", family: "jsts" },
  mts: { lang: "typescript", family: "jsts" },
  cts: { lang: "typescript", family: "jsts" },
  js: { lang: "javascript", family: "jsts" },
  jsx: { lang: "javascript", family: "jsts" },
  mjs: { lang: "javascript", family: "jsts" },
  cjs: { lang: "javascript", family: "jsts" },
  py: { lang: "python", family: "python" },
  go: { lang: "go", family: "go" },
  java: { lang: "java", family: "java" },
  kt: { lang: "kotlin", family: "java" },
  cs: { lang: "csharp", family: "java" },
  c: { lang: "c", family: "java" },
  h: { lang: "c", family: "java" },
  cpp: { lang: "cpp", family: "java" },
  hpp: { lang: "cpp", family: "java" },
  rs: { lang: "rust", family: "go" },
  rb: { lang: "ruby", family: "python" },
  php: { lang: "php", family: "java" },
  md: { lang: "markdown", family: "generic" },
  mdx: { lang: "markdown", family: "generic" },
};

// Lines that likely start a top-level unit, per language family.
const BOUNDARY: Record<Family, RegExp> = {
  jsts: /^(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|namespace)\b/,
  python: /^(def|class|async\s+def|@\w)/,
  go: /^(func|type|var|const|package)\b/,
  java: /^\s{0,4}(public|private|protected|static|final|abstract|class|interface|enum|record|void|struct|namespace)\b/,
  generic: /^(#{1,3}\s|[A-Za-z_[{(<@#/*-])/, // headings / any new top-level-ish line
};

export function detectLanguage(filePath: string): { lang: string; family: Family } {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? { lang: ext || "text", family: "generic" };
}

/**
 * Language-aware chunking: find likely function/class boundaries with per-family
 * regexes, then greedily pack boundary-delimited segments into 60–120 line chunks
 * with a 10-line overlap between adjacent chunks.
 */
export function chunkFile(filePath: string, content: string): Chunk[] {
  const { lang, family } = detectLanguage(filePath);
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const boundaryRe = BOUNDARY[family];
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (boundaryRe.test(lines[i])) boundaries.push(i);
  }
  boundaries.push(lines.length);

  // Segments between consecutive boundaries.
  const segments: Array<[number, number]> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i + 1] > boundaries[i]) segments.push([boundaries[i], boundaries[i + 1]]);
  }

  const chunks: Chunk[] = [];
  const push = (start: number, end: number) => {
    const slice = lines.slice(start, end).join("\n");
    if (!slice.trim()) return;
    chunks.push({
      filePath,
      startLine: start + 1,
      endLine: end,
      language: lang,
      content: slice,
    });
  };

  let cur = segments.length ? segments[0][0] : 0;
  let curEnd = cur;
  for (const [segStart, segEnd] of segments) {
    // Oversized single segment: hard-split with overlap.
    if (segEnd - segStart > TARGET_MAX) {
      if (curEnd > cur) push(cur, curEnd);
      let s = segStart;
      while (s < segEnd) {
        const e = Math.min(s + TARGET_MAX, segEnd);
        push(s, e);
        if (e >= segEnd) break;
        s = e - OVERLAP;
      }
      cur = segEnd;
      curEnd = segEnd;
      continue;
    }
    if (segEnd - cur > TARGET_MAX && curEnd - cur >= TARGET_MIN) {
      // Adding this segment would overflow; flush and start a new chunk with overlap.
      push(cur, curEnd);
      cur = Math.max(curEnd - OVERLAP, segStart - OVERLAP, 0);
    }
    curEnd = segEnd;
  }
  if (curEnd > cur) push(cur, curEnd);

  return chunks;
}

/** Context header prepended before embedding / prompting. */
export function chunkHeader(c: Chunk): string {
  return `// ${c.filePath} (lines ${c.startLine}-${c.endLine})`;
}

export function chunkRepo(files: Array<{ path: string; content: string }>): Chunk[] {
  return files.flatMap((f) => chunkFile(f.path, f.content));
}
