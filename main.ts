// mend: one patch tool for every AI edit format.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, the V4A patch format, JSON tool calls), finds the lines each edit
// names at the first of three matching tiers, and writes every change or
// none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// The working directory is the root of the tree. A check runs
// `node main.ts [arguments]` once in a fresh directory and compares the exit
// code, everything on standard output, and every file afterwards.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the whole run stops and prints one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  without the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// Files: lines, line breaks, and the final break (SPEC.md section 3).
// ---------------------------------------------------------------------------

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into its lines, its line break, and whether it ends
 *  with one. The break is CRLF when the first line feed follows a carriage
 *  return, LF otherwise. An empty file has no lines and no final break. */
function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Join lines back with the file's own break, and a final one exactly when
 *  the file ended with one. A file of no lines is written empty. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5).
// ---------------------------------------------------------------------------

/** One line of an old or a new side. `ctx` marks a context line: a line of
 *  both O and N in a unified hunk or a V4A chunk. */
interface Seg {
  text: string;
  ctx: boolean;
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Whether two lines are equal at a tier: tier 0 exactly, tier 1 once
 *  trailing spaces and tabs are removed from both, tier 2 once leading and
 *  trailing spaces and tabs are removed from both. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position at which O occurs in `lines` at a tier, searching
 *  from `from`. Occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  pos: number[];
}

/** O's occurrences at the first tier (0, then 1, then 2; only 0 with
 *  `--strict`) at which it occurs at least once, or null when it occurs at
 *  no tier. */
function firstTier(lines: string[], O: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, O, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line at the first
 *  tier where one is, or null. */
function firstTierSingle(lines: string[], one: string, strict: boolean, from: number): number | null {
  const found = firstTier(lines, [one], strict, from);
  return found === null ? null : found.pos[0]!;
}

/** Replace the matched lines at `at` by N. A context line of N is written
 *  as the file's own matched line, never the patch's. At tier 2 every other
 *  line of N is re-indented: F is the leading spaces and tabs of the file's
 *  first matched line, P those of O's first line, and a line of N that is not
 *  empty and not only whitespace, and starts with P, has that P replaced by
 *  F. At tiers 0 and 1 the lines of N are written as they are. */
function applySegs(lines: string[], O: Seg[], N: Seg[], tier: number, at: number): string[] {
  const out = lines.slice(0, at);
  // Pair the context lines of N with the context lines of O, in order: the
  // k-th context line of N is the file line of the k-th context line of O.
  const oCtx: number[] = [];
  O.forEach((s, j) => {
    if (s.ctx) oCtx.push(j);
  });
  const nCtxO: number[] = new Array<number>(N.length).fill(-1);
  let k = 0;
  N.forEach((s, i) => {
    if (s.ctx) {
      nCtxO[i] = oCtx[k]!;
      k += 1;
    }
  });
  const fLead = leadingWs(lines[at] ?? '');
  const pLead = O.length > 0 ? leadingWs(O[0]!.text) : '';
  for (let i = 0; i < N.length; i++) {
    const s = N[i]!;
    if (s.ctx) {
      out.push(lines[at + nCtxO[i]!]!);
    } else if (tier === 2 && s.text !== '' && s.text.trim() !== '' && s.text.startsWith(pLead)) {
      out.push(fLead + s.text.slice(pLead.length));
    } else {
      out.push(s.text);
    }
  }
  for (let i = at + O.length; i < lines.length; i++) out.push(lines[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it.
// ---------------------------------------------------------------------------

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. Moves are recorded so the output can print an
 *  `R old -> new` line for a move that succeeded. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Record a move: the old path is deleted, the new path holds `text`. */
  move(oldP: string, newP: string, text: string): void {
    this.moves.push([oldP, newP]);
    this.now.set(oldP, null);
    this.now.set(newP, text);
  }
}

/** One edit: a function of the tree that throws Fail when it fails, and
 *  changes nothing when it does. */
type Edit = (tree: Tree) => void;

/** The current text of a file an edit works on, or a `missing` failure. */
function existing(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/** A path every edit names is checked for safety before anything else. */
function checkSafe(...paths: string[]): void {
  for (const p of paths) {
    if (!safe(p)) throw new Fail('unsafe', p);
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  /** A: the hunk header's old start line, 1-based. */
  a: number;
  O: Seg[];
  N: Seg[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolNew: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
  /** The hunk holds at least one `+` line. */
  hasPlus: boolean;
}

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.*) b\/(.*)$/;

/** The path a `--- ` or `+++ ` line names: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed, a
 *  leading `a/` or `b/` removed, and `/dev/null` meaning no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Whether a `\` line follows the body's last context or `+` line, and
 *  whether one follows its last `+` line. */
function hunkNoEol(body: string[]): { noEolNew: boolean; noEolPlus: boolean; hasPlus: boolean } {
  let lastNew = -1;
  let lastPlus = -1;
  body.forEach((b, i) => {
    if (b === '' || b[0] === ' ') lastNew = i;
    else if (b[0] === '+') {
      lastNew = i;
      lastPlus = i;
    }
  });
  const follows = (i: number): boolean => i >= 0 && i + 1 < body.length && body[i + 1]!.startsWith('\\');
  return { noEolNew: follows(lastNew), noEolPlus: follows(lastPlus), hasPlus: lastPlus >= 0 };
}

/** A hunk's body, from the lines after its header: the lines that start with
 *  ` `, `-`, `+` or `\`, or are empty. The body ends at the first other line,
 *  at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at
 *  the end of the patch; empty lines at the end of a body are not part of it.
 *  Returns the hunk and the index of the first line after the body. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const O: Seg[] = [];
  const N: Seg[] = [];
  for (const b of body) {
    if (b.startsWith('\\')) continue;
    if (b === '') {
      O.push({ text: '', ctx: true });
      N.push({ text: '', ctx: true });
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      O.push({ text: t, ctx: true });
      N.push({ text: t, ctx: true });
    } else if (b[0] === '-') {
      O.push({ text: b.slice(1), ctx: false });
    } else if (b[0] === '+') {
      N.push({ text: b.slice(1), ctx: false });
    }
  }
  const { noEolNew, noEolPlus, hasPlus } = hunkNoEol(body);
  return { hunk: { a, O, N, noEolNew, noEolPlus, hasPlus }, next: j };
}

/** Apply a section's hunks in order, each to the result of the ones before
 *  it, and return the file's new text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = fileParts(before);
  let lines = parts.lines;
  let final = parts.final;
  // d: the sum over this section's hunks applied so far of (N's length minus
  // O's length).
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.O.map((s) => s.text);
    if (h.O.length === 0) {
      // N is inserted after the first A + d lines (all of them when the file
      // has fewer). There is no matched line, so no re-indentation applies.
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      const ins = h.N.map((s) => s.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) final = !h.noEolNew;
      d += h.N.length;
      continue;
    }
    const found = firstTier(lines, oTexts, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    // Of the occurrences at the tier where O is found, the hunk takes the
    // one whose 0-based position is nearest to A - 1 + d; of two equally
    // near, the earlier.
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsToEnd = best + h.O.length === lines.length;
    lines = applySegs(lines, h.O, h.N, found.tier, best);
    if (runsToEnd) final = h.N.length === 0 ? true : !h.noEolNew;
    d += h.N.length - h.O.length;
  }
  return joinFile(lines, parts.br, final);
}

/** Read a patch as a unified diff and return its sections' edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const fresh = (): Section => ({
    oldPath: undefined,
    newPath: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  });
  let cur: Section | null = null;
  // True while the current section has seen no hunk yet: its header.
  let inHeader = false;
  // True once the current section's header has its `---`/`+++` pair.
  let hasPair = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      hasPair = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        // The pair belongs to the current section's header.
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      // The pair is not already part of a section's header: it starts one.
      cur = fresh();
      cur.oldPath = headerPath(l);
      cur.newPath = headerPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      // Outside a section's header: prose, ignored.
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const { hunk, next } = parseHunkBody(lines, i + 1, Number(m[1]));
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFileMode = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFileMode = true;
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index` and `Index:` lines, and any other line, are
      // ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.oldPath !== undefined ? sec.oldPath : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.newPath !== undefined ? sec.newPath : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const isCreate = oldP === null || sec.newFileMode;
    const isDelete = newP === null || sec.deletedFileMode;
    if (isCreate && newP !== null && newP !== undefined) {
      const p = newP;
      const hunks = sec.hunks;
      return (tree: Tree): void => {
        checkSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        // The file is the `+` lines of all its hunks, in order. It ends
        // with a line break unless a `\` line follows its last `+` line.
        const plus: string[] = [];
        let noEol = false;
        for (const h of hunks) {
          for (const s of h.N) if (!s.ctx) plus.push(s.text);
          if (h.hasPlus) noEol = h.noEolPlus;
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDelete && oldP !== null && oldP !== undefined) {
      const p = oldP;
      return (tree: Tree): void => {
        checkSafe(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP) {
      const from = oldP;
      const to = newP;
      const hunks = sec.hunks;
      return (tree: Tree): void => {
        checkSafe(from, to);
        const before = tree.get(from);
        if (before === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const result = applyHunks(before, hunks, strict, from);
        tree.move(from, to, result);
      };
    }
    const p = (oldP !== null && oldP !== undefined ? oldP : newP) as string | undefined;
    const hunks = sec.hunks;
    return (tree: Tree): void => {
      if (p === undefined) return;
      checkSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, hunks, strict, p));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

/** Read a patch as SEARCH/REPLACE blocks and return their edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  // The index after the previous block's `>>>>>>> REPLACE` line.
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      // The path is the nearest line before the SEARCH line, and after the
      // previous block's REPLACE line (or the start of the patch), that is
      // not blank and, its surrounding whitespace removed, does not start
      // with three backticks.
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const p = b.path;
    const old = b.old;
    const nw = b.nw;
    return (tree: Tree): void => {
      checkSafe(p);
      if (old.length === 0) {
        // The file is created with the new lines.
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const found = firstTier(parts.lines, old, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      // The old lines occur at their tier exactly once.
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const O = old.map((t) => ({ text: t, ctx: false }));
      const N = nw.map((t) => ({ text: t, ctx: false }));
      const lines = applySegs(parts.lines, O, N, found.tier, found.pos[0]!);
      tree.now.set(p, joinFile(lines, parts.br, parts.final));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** The anchor, or '' for no anchor. */
  anchor: string;
  O: Seg[];
  N: Seg[];
  /** The chunk is anchored to the end of the file. */
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  pathLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(V4A_ADD)) return 'add';
  if (line.startsWith(V4A_DELETE)) return 'delete';
  if (line.startsWith(V4A_UPDATE)) return 'update';
  return null;
}

/** Parse one V4A section's lines (trailing blank lines already removed):
 *  an Add File section's lines, a Delete File section's (none), or an
 *  Update File section's chunks. */
function parseV4aSection(sec: V4aSection, lines: { text: string; num: number }[]): void {
  if (sec.kind === 'add') {
    for (const { text, num } of lines) {
      if (text.startsWith('+')) sec.addLines.push(text.slice(1));
      else if (text === '') sec.addLines.push('');
      else throw new Exit2(`error: parse ${num}`);
    }
    return;
  }
  if (sec.kind === 'delete') {
    for (const { text, num } of lines) {
      throw new Exit2(`error: parse ${num}`);
    }
    return;
  }
  // Update File: `*** Move to: <path>` as its first line, then chunks.
  let idx = 0;
  if (idx < lines.length && lines[idx]!.text.startsWith(V4A_MOVE)) {
    sec.moveTo = lines[idx]!.text.slice(V4A_MOVE.length).trim();
    idx += 1;
  }
  let cur: V4aChunk | null = null;
  for (; idx < lines.length; idx++) {
    const { text, num } = lines[idx]!;
    if (text.startsWith('@@')) {
      cur = { anchor: text.slice(2).trim(), O: [], N: [], eof: false };
      sec.chunks.push(cur);
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${num}`);
        // The first chunk may start at a body line: no anchor.
        cur = { anchor: '', O: [], N: [], eof: false };
        sec.chunks.push(cur);
      }
      if (text === '') {
        cur.O.push({ text: '', ctx: true });
        cur.N.push({ text: '', ctx: true });
      } else if (text[0] === ' ') {
        const t = text.slice(1);
        cur.O.push({ text: t, ctx: true });
        cur.N.push({ text: t, ctx: true });
      } else if (text[0] === '-') {
        cur.O.push({ text: text.slice(1), ctx: false });
      } else {
        cur.N.push({ text: text.slice(1), ctx: false });
      }
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.pathLine}`);
}

/** Read a patch as a V4A patch and return its sections' edits. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // Split the lines between Begin Patch and End Patch into sections.
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let curLines: { text: string; num: number }[] = [];
  const close = (): void => {
    if (cur === null) return;
    // Blank lines at the end of a section (before the next section or
    // `*** End Patch`) are not part of it: a blank line is one that is
    // empty or only whitespace.
    while (curLines.length > 0 && blank(curLines[curLines.length - 1]!.text)) curLines.pop();
    parseV4aSection(cur, curLines);
    cur = null;
    curLines = [];
  };
  for (let i = first + 1; i < last; i++) {
    const text = lines[i]!;
    const kind = v4aSectionKind(text);
    if (kind !== null) {
      close();
      const prefix = kind === 'add' ? V4A_ADD : kind === 'delete' ? V4A_DELETE : V4A_UPDATE;
      cur = { kind, path: text.slice(prefix.length).trim(), pathLine: i + 1, moveTo: null, addLines: [], chunks: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (!blank(text)) throw new Exit2(`error: parse ${i + 1}`);
      // Blank lines between sections are ignored.
      continue;
    }
    curLines.push({ text, num: i + 1 });
  }
  close();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      const addLines = sec.addLines;
      return (tree: Tree): void => {
        checkSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      return (tree: Tree): void => {
        checkSafe(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree): void => {
      checkSafe(p);
      if (moveTo !== null) checkSafe(moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const parts = fileParts(before);
      let lines = parts.lines;
      // The cursor starts at line 0.
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== '') {
          // Find the first line at or after the cursor equal to the anchor
          // at the first tier where one is; the cursor moves past it.
          const at = firstTierSingle(lines, ch.anchor, strict, cursor);
          if (at === null) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const oTexts = ch.O.map((s) => s.text);
        if (ch.O.length === 0) {
          // N is inserted at the cursor, or at the end of the file for an
          // end-of-file chunk.
          const at = ch.eof ? lines.length : cursor;
          const ins = ch.N.map((s) => s.text);
          lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
          cursor = at + ins.length;
          continue;
        }
        const found = firstTier(lines, oTexts, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        let at = found.pos[0]!;
        if (ch.eof) {
          // An end-of-file chunk takes only an occurrence that ends at the
          // file's last line.
          const end = found.pos.find((q) => q + ch.O.length === lines.length);
          if (end === undefined) throw new Fail('no-match', p);
          at = end;
        }
        lines = applySegs(lines, ch.O, ch.N, found.tier, at);
        // The cursor moves to just after the lines written.
        cursor = at + ch.N.length;
      }
      const result = joinFile(lines, parts.br, parts.final);
      if (moveTo !== null) tree.move(p, moveTo, result);
      else tree.now.set(p, result);
    };
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = fileParts(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      const lines = parts.lines.slice();
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, parts.br, parts.final));
    };
  }
  return null;
}

/** Read a patch as JSON edits: either one JSON array of edit objects, or
 *  JSON Lines with one edit object a line, blank lines ignored. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4).
// ---------------------------------------------------------------------------

/** With `--format=auto` the format is the first of these that holds, where a
 *  blank line is one that is empty or only whitespace. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// The command line, output and exit codes (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order to the tree as earlier edits left it. A
  // failed edit changes nothing, and the edits after it still run, so every
  // failure is reported. When any edit failed, no file is written.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths
  // (UTF-8). A move that succeeded prints `R <old> -> <new>` when the old
  // path existed before the patch and does not after it, and the new path
  // did not exist before it and does after it; it replaces that pair's `D`
  // and `A` lines and sorts by `<new>`.
  const movedTo = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (tree.original(oldP) !== null && nowOld === null && tree.original(newP) === null && nowNew !== null) {
      movedTo.set(newP, oldP);
    }
  }
  const movedFrom = new Set<string>(movedTo.values());
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p)) continue;
    if (movedTo.has(p)) {
      rows.push({ key: p, text: `R ${movedTo.get(p)} -> ${p}` });
      continue;
    }
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
