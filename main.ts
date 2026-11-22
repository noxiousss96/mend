// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** (old, new) pairs of move edits that succeeded, for the R lines. */
  readonly moves: Array<[string, string]> = [];
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
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** A line normalised at a matching tier (SPEC.md section 5). */
function normLine(l: string, tier: number): string {
  if (tier === 0) return l;
  if (tier === 1) return l.replace(/[ \t]+$/, '');
  return l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** Positions where O occurs in the file's lines at a tier; occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) if (normLine(file[i + k]!, tier) !== want[k]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0..2, or 0 only when strict) at which O occurs, with its positions. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const occ = occurrences(file, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One hunk/chunk body line: ' ' context, '-' old, '+' new. */
type Op = [string, string];

/**
 * The lines that replace O at `at`: context lines are the file's own matched lines, the rest
 * the patch's, re-indented at tier 2 (SPEC.md section 5).
 */
function replacement(file: string[], at: number, ops: Op[], tier: number): string[] {
  const out: Array<{ ctx: boolean; text: string }> = [];
  let oldIdx = 0;
  for (const [kind, text] of ops) {
    if (kind === '-') { oldIdx += 1; continue; }
    if (kind === ' ') { out.push({ ctx: true, text: file[at + oldIdx]! }); oldIdx += 1; continue; }
    out.push({ ctx: false, text });
  }
  if (tier === 2) {
    const oFirst = ops.find(([k]) => k === ' ' || k === '-')?.[1];
    if (oFirst !== undefined) {
      const p = /^[ \t]*/.exec(oFirst)![0];
      const f = /^[ \t]*/.exec(file[at]!)![0];
      if (p !== f) {
        for (const l of out) {
          if (!l.ctx && l.text.trim() !== '' && l.text.startsWith(p)) l.text = f + l.text.slice(p.length);
        }
      }
    }
  }
  return out.map((l) => l.text);
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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

/** One unified hunk: A is its old start line, noNL whether a `\` line follows its last context or `+` line, plusNoNL whether one follows its last `+` line. */
interface Hunk {
  a: number;
  ops: Op[];
  noNL: boolean;
  plusNoNL: boolean;
}
/** One unified section: a null path is /dev/null, no file. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: up to the first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function cleanPath(s: string): string | null {
  let p = s.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse one section's header and hunks from `start`; returns the index after the section. */
function parseUniSection(lines: string[], start: number, sec: UniSection): number {
  let i = start;
  const n = lines.length;
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      dashOld = cleanPath(l.slice(4));
      dashNew = cleanPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('+++ ')) { dashNew = cleanPath(l.slice(4)); i += 1; continue; }
    if (l.startsWith('rename from ')) { renOld = l.slice('rename from '.length).trim(); i += 1; continue; }
    if (l.startsWith('rename to ')) { renNew = l.slice('rename to '.length).trim(); i += 1; continue; }
    if (l.startsWith('new file mode')) { sec.creation = true; i += 1; continue; }
    if (l.startsWith('deleted file mode')) { sec.deletion = true; i += 1; continue; }
    i += 1;
  }
  if (dashOld !== undefined) sec.oldPath = dashOld;
  else if (renOld !== undefined) sec.oldPath = renOld;
  if (dashNew !== undefined) sec.newPath = dashNew;
  else if (renNew !== undefined) sec.newPath = renNew;
  while (i < n) {
    const l = lines[i]!;
    if (!l.startsWith('@@')) break;
    const hm = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (!hm) throw new Exit2(`error: parse ${i + 1}`);
    const a = Number(hm[1]);
    i += 1;
    const body: string[] = [];
    while (i < n) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); i += 1; }
      else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const ops: Op[] = [];
    for (const b of body) {
      if (b === '') ops.push([' ', '']);
      else if (b.startsWith(' ')) ops.push([' ', b.slice(1)]);
      else if (b.startsWith('-')) ops.push(['-', b.slice(1)]);
      else if (b.startsWith('+')) ops.push(['+', b.slice(1)]);
    }
    let noNL = false;
    let plusNoNL = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const b = body[k]!;
      if (b === '' || b.startsWith(' ') || b.startsWith('+')) { noNL = k + 1 < body.length && body[k + 1]!.startsWith('\\'); break; }
    }
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.startsWith('+')) { plusNoNL = k + 1 < body.length && body[k + 1]!.startsWith('\\'); break; }
    }
    sec.hunks.push({ a, ops, noNL, plusNoNL });
  }
  return i;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { oldPath: m[1]!, newPath: m[2]!, creation: false, deletion: false, hunks: [] };
      i = parseUniSection(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
      i = parseUniSection(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o = h.ops.filter(([k]) => k === ' ' || k === '-').map(([, t]) => t);
    const nLen = h.ops.filter(([k]) => k === ' ' || k === '+').length;
    if (o.length === 0) {
      const n = h.ops.filter(([k]) => k === '+').map(([, t]) => t);
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...n);
      if (atEnd) f.final = !h.noNL;
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const n = replacement(f.lines, best, h.ops, found.tier);
    const atEnd = best + o.length === f.lines.length;
    f.lines.splice(best, o.length, ...n);
    if (atEnd) f.final = !h.noNL;
    d += nLen - o.length;
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => (tree: Tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.creation || oldP === null) {
      const p = newP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let plusNoNL = false;
      for (const h of sec.hunks) {
        const hasPlus = h.ops.some(([k]) => k === '+');
        for (const [k, t] of h.ops) if (k === '+') out.push(t);
        if (hasPlus) plusNoNL = h.plusNoNL;
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (plusNoNL ? '' : '\n'));
      return;
    }
    if (sec.deletion || newP === null) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, after);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  });
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevPath = path;
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p: string, oldL: string[], newL: string[]) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldL, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const ops: Op[] = [...oldL.map((t): Op => ['-', t]), ...newL.map((t): Op => ['+', t])];
      const n = replacement(f.lines, found.occ[0]!, ops, found.tier);
      f.lines.splice(found.occ[0]!, oldL.length, ...n);
      tree.now.set(p, joinFile(f));
    })(path, oldLines, newLines));
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: anchor is null when the @@ line carries no text. */
interface V4AChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}
interface V4ASection {
  kind: string;
  path: string;
  lines: string[];
  moveTo?: string;
  chunks: V4AChunk[];
}

/** Parse an Update File section's body into its move and chunks. */
function parseV4AChunks(body: string[], bodyStart: number, headerLine: number): { moveTo?: string; chunks: V4AChunk[] } {
  let moveTo: string | undefined;
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let i = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    i = 1;
  }
  const flush = (): void => { if (cur !== null) { chunks.push(cur); cur = null; } };
  for (; i < body.length; i++) {
    const b = body[i]!;
    const lineNo = bodyStart + i + 1;
    if (b.startsWith('@@')) {
      flush();
      cur = { anchor: b.slice(2).trim() || null, ops: [], eof: false };
      continue;
    }
    if (b.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, ops: [], eof: false };
      }
      cur.ops.push(b === '' ? [' ', ''] : [b[0]!, b.slice(1)]);
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headerLine + 1}`);
  return { moveTo, chunks };
}

/** V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (!blank(lines[i]!)) { first = i; break; }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  for (let i = lines.length - 1; i >= 0; i--) if (!blank(lines[i]!)) { last = i; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    const headerLine = i;
    i += 1;
    const body: string[] = [];
    const bodyStart = i;
    while (i < last) {
      const b = lines[i]!;
      if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
      if (b.trim() === '*** End Patch') break;
      body.push(b);
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith('+')) out.push(b.slice(1));
        else if (b === '') out.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      sections.push({ kind, path, lines: out, chunks: [] });
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      sections.push({ kind, path, lines: [], chunks: [] });
    } else {
      const { moveTo, chunks } = parseV4AChunks(body, bodyStart, headerLine);
      sections.push({ kind, path, lines: [], moveTo, chunks });
    }
  }
  return sections.map((sec) => (tree: Tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let found: number | null = null;
        const max = strict ? 0 : 2;
        for (let tier = 0; tier <= max && found === null; tier++) {
          for (let j = cursor; j < f.lines.length; j++) {
            if (normLine(f.lines[j]!, tier) === normLine(ch.anchor, tier)) { found = j; break; }
          }
        }
        if (found === null) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const o = ch.ops.filter(([k]) => k === ' ' || k === '-').map(([, t]) => t);
      if (o.length === 0) {
        const n = ch.ops.filter(([k]) => k === '+').map(([, t]) => t);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...n);
        cursor = at + n.length;
        continue;
      }
      let hit: { tier: number; at: number } | null = null;
      const max = strict ? 0 : 2;
      for (let tier = 0; tier <= max && hit === null; tier++) {
        for (const pos of occurrences(f.lines, o, tier)) {
          if (pos < cursor) continue;
          if (ch.eof && pos + o.length !== f.lines.length) continue;
          hit = { tier, at: pos };
          break;
        }
      }
      if (hit === null) throw new Fail('no-match', p);
      const n = replacement(f.lines, hit.at, ch.ops, hit.tier);
      f.lines.splice(hit.at, o.length, ...n);
      cursor = hit.at + n.length;
    }
    const after = joinFile(f);
    if (sec.moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, after);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, after);
    }
  });
}

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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rPairs = new Map<string, string>();
  const rNews = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rPairs.set(o, n);
      rNews.add(n);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (rPairs.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = rows.map((r) => r.line);
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
