import path from 'node:path';
import { assertPortableFilesystemSegment, portableCaseFold } from './library-runtime.ts';

/** Paths are relative to the exported module root, not the current project. */
export function runtimePath(value: string) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || path.posix.normalize(value) !== value || value.split('/').some(p => p === '..' || p === '.')) throw new Error(`unsafe runtime path: ${value}`);
  for (const segment of value.split('/')) assertPortableFilesystemSegment(segment, 'runtime path');
  if (value.split('/').some(p => /^(gallery|inbox)$/i.test(p))) throw new Error(`runtime path depends on pre-publication directory: ${value}`);
  return value;
}

// A bounded R file-I/O scanner, not an R interpreter. Unknown/dynamic expressions
// are explicitly reported rather than guessing from extensions or basenames.
interface Token { value: string; string?: boolean; line: number }
function tokens(code: string): Token[] {
  const out: Token[] = []; let i = 0, line = 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c; let s = ''; i++;
      while (i < code.length && code[i] !== quote) { if (code[i] === '\\') { s += code[i++]!; if (i < code.length) s += code[i++]!; } else s += code[i++]!; }
      i++; out.push({ value: s, string: true, line }); continue;
    }
    const word = /^[A-Za-z_.][A-Za-z0-9_.]*/.exec(code.slice(i));
    if (word) { out.push({ value: word[0], line }); i += word[0].length; continue; }
    const op = ['<-','::','=='].find(op => code.startsWith(op, i));
    out.push({ value: op ?? c, line }); i += op?.length ?? 1;
  }
  return out;
}
function argumentsAt(t: Token[], start: number) {
  const args: Token[][] = []; let cur: Token[] = [], depth = 0, end = start;
  for (let i = start; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.value === ')' && depth === 0) { args.push(cur); end = i; return { args, end }; }
    if (tok.value === ',' && depth === 0) { args.push(cur); cur = []; continue; }
    if (tok.value === '(' || tok.value === '[') depth++;
    if (tok.value === ')' || tok.value === ']') depth--;
    cur.push(tok);
  }
  return { args: [], end };
}
const READERS = new Set(['read.csv','read.csv2','read.delim','read.table','readLines','readRDS','load','read.tree','read.newick','read.dna','read_csv','read_tsv','read_delim','read_excel','read_xlsx','readDNAStringSet','readAAStringSet','fread','source','sys.source','read_fasta']);
export interface RuntimeRead { path?: string; expression: string; line: number; kind: 'code'|'data' }
export function inspectRuntimeReads(code: string): RuntimeRead[] {
  const t = tokens(code), bindings = new Map<string, Token[]>();
  for (let i = 0; i < t.length - 2; i++) {
    if (!t[i]!.string && ['<-','='].includes(t[i + 1]!.value)) {
      let j = i + 2, depth = 0; const expr: Token[] = [];
      while (j < t.length) {
        const tok = t[j]!;
        if (depth === 0 && (tok.line > t[i + 2]!.line || [',',';',')','}'].includes(tok.value))) break;
        if (tok.value === '(') depth++; if (tok.value === ')') depth--;
        expr.push(tok); j++;
      }
      bindings.set(t[i]!.value, expr);
    }
  }
  const resolve = (e: Token[], seen = new Set<string>()): string | undefined => {
    if (e[1]?.value === '=') e = e.slice(2);
    if (e.length === 1 && e[0]!.string) return e[0]!.value;
    if (e.length === 1) {
      const name = e[0]!.value;
      if (name === 'root') return '';
      if (name === 'script_dir') return 'code';
      if (seen.has(name)) return;
      const expr = bindings.get(name); return expr ? resolve(expr, new Set([...seen,name])) : undefined;
    }
    if (e[0]?.value === 'file.path' && e[1]?.value === '(') {
      const { args } = argumentsAt(e, 2), parts = args.map(a => resolve(a, seen));
      if (parts.some(p => p === undefined)) return;
      // Do not normalize away traversal: runtimePath must reject it.
      return parts.filter(p => p !== '').join('/');
    }
    return undefined;
  };
  const reads: RuntimeRead[] = [];
  for (let i = 0; i < t.length - 1; i++) {
    const name = t[i]!.value;
    if (t[i]!.string || !READERS.has(name) || t[i + 1]!.value !== '(') continue;
    const { args } = argumentsAt(t, i + 2);
    // text= constructs a tree/table in memory; it is not a file input.
    if (args.some(a => a[0]?.value === 'text' && a[1]?.value === '=')) continue;
    const fileArg = args.find(a => ['file','path','con','input'].includes(a[0]?.value ?? '') && a[1]?.value === '=') ?? args[0] ?? [];
    reads.push({ path: resolve(fileArg), expression: fileArg.map(t => t.string ? JSON.stringify(t.value) : t.value).join(''), line: t[i]!.line, kind: /source$/.test(name) ? 'code' : 'data' });
  }
  return reads;
}
export function assertRuntimeReads(code: string, declared: string[], label: string) {
  const known = new Set(declared.map(runtimePath));
  for (const read of inspectRuntimeReads(code)) {
    if (read.path === undefined) throw new Error(`${label}: unresolved runtime input ${read.expression} at line ${read.line}; use an explicit module-relative file path`);
    const requested = runtimePath(read.path);
    if (!known.has(requested)) throw new Error(`${label}: missing runtime input ${requested} at line ${read.line}`);
  }
}
export function assertUniqueRuntimePaths(values: string[]) {
  const seen = new Set<string>();
  for (const value of values) { const key = portableCaseFold(runtimePath(value)); if (seen.has(key)) throw new Error(`duplicate runtime path: ${value}`); seen.add(key); }
}
