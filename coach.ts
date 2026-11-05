#!/usr/bin/env bun
const DOC = `english-peer: pulls the prompts you typed into Claude Code and keeps a
searchable history of every daily review.

Data (in $ENGLISH_PEER_DATA, default ~/.local/share/english-peer):
  journal.jsonl   one line per review run (append-only, greppable)
  patterns.json   recurring mistakes: definitions; stats are derived from the journal
  config.json     artifact url, filters, batch sizes

Commands:
  context  [--date D | --since D [--until D]]   everything the daily run needs, as JSON
  prompts  [--date D | --since D [--until D]] [--text]
  record   FILE.json | -                        validate + append a review, merge new patterns
  render   [--run DATE]                         build the artifact page for a review
  search   TERM                                 grep findings, vocab and patterns
  patterns [--all]                              recurring mistakes with stats
  stats                                         last 14 reviews
  backlog                                       unreviewed days with prompt counts
  set-url  URL                                  remember the artifact link for later runs
  used     WORD [WORD...]                       how often I've written each word/phrase, ever

Day selection (no flags): unreviewed days, newest first, starting with
yesterday. Older days are added until the batch has \`target_prompts\`,
without going past \`max_prompts\`. A quiet day therefore pulls in backlog,
and the history before the first run gets worked through over time.`;

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

const HOME = homedir();
const CODE = import.meta.dir;
const DATA = process.env.ENGLISH_PEER_DATA || join(HOME, ".local", "share", "english-peer");
const HISTORY = join(HOME, ".claude", "history.jsonl");
const JOURNAL = join(DATA, "journal.jsonl");
const PATTERNS = join(DATA, "patterns.json");
const CONFIG = join(DATA, "config.json");
const TEMPLATE = join(CODE, "template.html");
const PAGE = join(DATA, "out", "english-peer.html");

// The daily run's own prompt carries this marker so it never reviews itself.
const RUN_MARKER = "ENGLISH-COACH-RUN";
const PLACEHOLDER = /\[(Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]/g;
const KINDS = new Set(["grammar", "vocabulary", "phrasing", "punctuation", "tone"]);
// everyday verbs I lean on; the coach suggests sharper ones
const WEAK_VERBS = ["do", "make", "check", "see", "get", "put", "give", "take", "fix", "run", "use",
  "try", "look", "have", "want", "need", "say", "tell", "show", "change", "go", "work"];
const LEARN_FIELDS: Record<string, string[]> = {
  verbs: ["verb", "meaning", "example"],
  phrasal_verbs: ["phrase", "meaning", "example"],
  words: ["word", "meaning", "example"],
  alternatives: ["you_wrote", "options"],
};
const MASTERED_AFTER_RUNS = 14; // pattern absent from this many later reviews -> mastered
const IMPROVING_AFTER_RUNS = 3;

type Json = any;
interface Prompt { id: string; time: string; project: string; text: string }
interface Finding { kind: string; original: string; corrected: string; why: string; pattern_id?: string | null; show?: boolean; [k: string]: Json }
interface Vocab { instead_of: string; use: string; example: string }
interface Run {
  date: string; days?: string[]; prompt_count: number; word_count: number; headline: string;
  findings: Finding[]; vocabulary?: Vocab[]; learn?: Record<string, Record<string, Json>[]>;
  error_rate?: number | null; backlog_days_left?: number; [k: string]: Json;
}
interface PatternDef { id: string; label: string; kind: string; rule: string }
interface PatternStats extends PatternDef {
  count: number; examples: { date: string; original: string; corrected: string }[];
  first_seen: string | null; last_seen: string | null; runs_since_last_seen: number;
  status: "new" | "active" | "improving" | "mastered"; runs_seen: number;
}
type Config = {
  artifact_url: string | null; ignore_project_prefixes: string[]; ignore_prompts_containing: string[];
  min_words: number; target_prompts: number; max_prompts: number; [k: string]: Json;
};
type DayArgs = { date?: string; since?: string; until?: string };

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

// json.dumps-style single line ("a": 1, "b": 2) so the journal stays greppable as `"date": "..."`
function jsonLine(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(jsonLine).join(", ")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${jsonLine(x)}`).join(", ")}}`;
  return JSON.stringify(v ?? null);
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return isoDate(d); };
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const tilde = (p: string) => p.split(HOME).join("~");

// Python-style repr for strings, so search output reads 'like this'
function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").split(q).join("\\" + q) + q;
}

const pyList = (xs: string[]) => `[${xs.map(repr).join(", ")}]`;

function config(): Config {
  return {
    artifact_url: null,
    ignore_project_prefixes: ["/private/tmp", "/tmp"],
    // canned prompts from automations / templates, not written by me
    ignore_prompts_containing: [],
    min_words: 3,
    target_prompts: 60,
    max_prompts: 250,
    ...loadJson(CONFIG, {}),
  };
}

function journal(): Run[] {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Run).sort((a, b) => a.date.localeCompare(b.date));
}

function coveredDays(runs: Run[]): Set<string> {
  return new Set(runs.flatMap((r) => r.days ?? []));
}

function clean(text: string): string {
  return text.replace(PLACEHOLDER, " ").replace(/[ \t]+/g, " ").trim();
}

/** Every prompt I typed, cleaned and filtered, grouped by local date. */
function allPrompts(cfg: Config): Map<string, Prompt[]> {
  const byDay = new Map<string, Prompt[]>();
  const seen = new Set<string>();
  for (const line of readFileSync(HISTORY, "utf8").split("\n")) {
    let r: Json;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const project: string = r.project || "";
    if (cfg.ignore_project_prefixes.some((p) => project.startsWith(p))) continue;
    let raw: string = r.display || "";
    if (raw.startsWith("!") || [RUN_MARKER, ...cfg.ignore_prompts_containing].some((m) => raw.includes(m))) continue;
    if (raw.startsWith("/")) raw = raw.trim().match(/^\S+\s+([\s\S]*)$/)?.[1] ?? ""; // keep the free text after a slash command, drop the command
    const text = clean(raw);
    if (words(text).length < cfg.min_words || seen.has(text)) continue; // "ok", "yes", resubmits
    seen.add(text);
    const ts = new Date(r.timestamp);
    const day = isoDate(ts);
    const [hh, mm, ss] = [ts.getHours(), ts.getMinutes(), ts.getSeconds()].map(pad);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push({
      id: `${day.replaceAll("-", "")}-${hh}${mm}${ss}`,
      time: `${day} ${hh}:${mm}`,
      project: tilde(project),
      text,
    });
  }
  return byDay;
}

function selectDays(args: DayArgs, byDay: Map<string, Prompt[]>, runs: Run[], cfg: Config): string[] {
  if (args.date) return [args.date];
  if (args.since) {
    const until = args.until || today();
    return [...byDay.keys()].filter((d) => args.since! <= d && d <= until).sort();
  }
  const y = yesterday();
  const done = coveredDays(runs);
  const picked: string[] = [];
  let total = 0;
  for (const day of [...byDay.keys()].filter((d) => d <= y && !done.has(d)).sort().reverse()) {
    const n = byDay.get(day)!.length;
    if (picked.length && total + n > cfg.max_prompts) continue; // too big for this batch; a later quiet day will pick it up
    picked.push(day);
    total += n;
    if (total >= cfg.target_prompts) break;
  }
  return picked.sort();
}

function promptsFor(days: string[], byDay: Map<string, Prompt[]>): Prompt[] {
  return days.flatMap((d) => byDay.get(d) ?? []);
}

function patternStats(runs: Run[], defs: Record<string, PatternDef>): PatternStats[] {
  // runs are counted by position, since one day can hold several runs
  const stats = new Map(Object.entries(defs).map(([pid, p]) =>
    [pid, { ...p, count: 0, runs: [] as number[], examples: [] as PatternStats["examples"] }]));
  runs.forEach((r, i) => {
    for (const f of r.findings ?? []) {
      const s = stats.get(f.pattern_id as string);
      if (!s) continue;
      s.count += 1;
      if (!s.runs.includes(i)) s.runs.push(i);
      s.examples.push({ date: r.date, original: f.original, corrected: f.corrected });
    }
  });
  const out: PatternStats[] = [...stats.values()].map(({ runs: seen, ...s }) => {
    const last = seen.at(-1);
    const since = last !== undefined ? runs.length - 1 - last : 0;
    return {
      ...s,
      examples: s.examples.slice(-3),
      first_seen: seen.length ? runs[seen[0]].date : null,
      last_seen: last !== undefined ? runs[last].date : null,
      runs_since_last_seen: since,
      status: !seen.length ? "new" : since >= MASTERED_AFTER_RUNS ? "mastered"
        : since >= IMPROVING_AFTER_RUNS ? "improving" : "active",
      runs_seen: seen.length,
    };
  });
  return out.sort((a, b) => Number(a.status === "mastered") - Number(b.status === "mastered") || b.count - a.count);
}

/** Everything already suggested, lowercased, so it isn't suggested again. */
function taught(runs: Run[]): string[] {
  const out = new Set(runs.flatMap((r) => (r.vocabulary ?? []).map((v) => v.use.toLowerCase())));
  for (const r of runs)
    for (const [key, fields] of Object.entries(LEARN_FIELDS))
      if (key !== "alternatives")
        for (const i of r.learn?.[key] ?? []) out.add(String(i[fields[0]]).toLowerCase());
  return [...out].sort();
}

function wordCounts(texts: string[], ws: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of ws) {
    const rx = new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(w.toLowerCase())}(?![\\p{L}\\p{N}_])`, "gu");
    counts[w] = texts.reduce((n, t) => n + (t.toLowerCase().match(rx)?.length ?? 0), 0);
  }
  return counts;
}

function cmdUsed(ws: string[]) {
  const texts = [...allPrompts(config()).values()].flat().map((p) => p.text);
  for (const [w, n] of Object.entries(wordCounts(texts, ws))) console.log(`${String(n).padStart(5)}  ${w}`);
}

function cmdPrompts(args: DayArgs & { text?: boolean }) {
  const cfg = config(), runs = journal();
  const byDay = allPrompts(cfg);
  const days = selectDays(args, byDay, runs, cfg);
  const prompts = promptsFor(days, byDay);
  if (args.text) for (const p of prompts) console.log(`[${p.id}] ${p.text}\n`);
  else console.log(JSON.stringify({ days, prompts }, null, 1));
}

function cmdContext(args: DayArgs) {
  const cfg = config(), runs = journal();
  const byDay = allPrompts(cfg);
  const days = selectDays(args, byDay, runs, cfg);
  const prompts = promptsFor(days, byDay);
  const y = yesterday();
  const done = coveredDays(runs);
  const backlog = [...byDay.keys()].filter((d) => d <= y && !done.has(d) && !days.includes(d));
  const stats = patternStats(runs, loadJson(PATTERNS, {}));
  const texts = prompts.map((p) => p.text);
  console.log(JSON.stringify({
    run_date: today(),
    days,
    includes_backlog: days.length > 0 && (days.at(-1) !== y || days.length > 1),
    backlog_days_left: backlog.length,
    artifact_url: cfg.artifact_url,
    prompt_count: prompts.length,
    word_count: texts.reduce((n, t) => n + words(t).length, 0),
    prompts,
    patterns: stats.filter((s) => s.status !== "mastered").map(({ id, label, kind, rule, status, count, runs_seen, last_seen, examples }) =>
      ({ id, label, kind, rule, status, count, runs_seen, last_seen, examples })),
    mastered_patterns: stats.filter((s) => s.status === "mastered").map((s) => s.id),
    recent_runs: runs.slice(-7).map((r) => ({
      date: r.date, days: r.days ?? null, error_rate: r.error_rate ?? null, headline: r.headline ?? null,
      pattern_ids: [...new Set((r.findings ?? []).map((f) => f.pattern_id).filter(Boolean))].sort(),
    })),
    already_taught: taught(runs),
    weak_verb_counts: Object.fromEntries(Object.entries(wordCounts(texts, WEAK_VERBS))
      .sort((a, b) => b[1] - a[1]).filter(([, n]) => n)),
  }, null, 1));
}

function validate(entry: Json, defs: Record<string, PatternDef>): string[] {
  const errs: string[] = [];
  for (const key of ["date", "days", "prompt_count", "word_count", "headline", "findings"])
    if (!(key in entry)) errs.push(`missing '${key}'`);
  const newIds = new Set((entry.new_patterns ?? []).map((p: Json) => p.id));
  (entry.findings ?? []).forEach((f: Json, i: number) => {
    for (const key of ["kind", "original", "corrected", "why"])
      if (!f[key]) errs.push(`findings[${i}] missing '${key}'`);
    if (f.kind && !KINDS.has(f.kind))
      errs.push(`findings[${i}].kind '${f.kind}' not in ${pyList([...KINDS].sort())} (typos are not recorded)`);
    const pid = f.pattern_id;
    if (pid && !(pid in defs) && !newIds.has(pid)) errs.push(`findings[${i}].pattern_id '${pid}' unknown: add it to new_patterns`);
  });
  const shown = (entry.findings ?? []).filter((f: Json) => f.show);
  if (entry.findings?.length && !(shown.length >= 1 && shown.length <= 7))
    errs.push(`mark 1-7 findings with "show": true for the page (got ${shown.length})`);
  (entry.new_patterns ?? []).forEach((p: Json, i: number) => {
    for (const key of ["id", "label", "kind", "rule"])
      if (!p[key]) errs.push(`new_patterns[${i}] missing '${key}'`);
    if (p.id && !/^[a-z0-9-]+$/.test(p.id)) errs.push(`new_patterns[${i}].id must be kebab-case`);
  });
  for (const [key, items] of Object.entries<Json[]>(entry.learn ?? {})) {
    if (!(key in LEARN_FIELDS)) {
      errs.push(`learn.${key} unknown; use ${pyList(Object.keys(LEARN_FIELDS).sort())}`);
      continue;
    }
    if (items.length > 3) errs.push(`learn.${key} has ${items.length} items; max 3 to keep the page short`);
    items.forEach((item, i) => {
      for (const field of LEARN_FIELDS[key])
        if (!item[field]) errs.push(`learn.${key}[${i}] missing '${field}'`);
    });
  }
  (entry.vocabulary ?? []).forEach((v: Json, i: number) => {
    for (const key of ["instead_of", "use", "example"])
      if (!v[key]) errs.push(`vocabulary[${i}] missing '${key}'`);
  });
  return errs;
}

async function cmdRecord(file: string) {
  const entry: Run = JSON.parse(file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8"));
  const defs = loadJson<Record<string, PatternDef>>(PATTERNS, {});
  const errs = validate(entry, defs);
  if (errs.length) die("record: invalid entry\n  " + errs.join("\n  "));
  // re-recording the same batch replaces it; a second batch on the same day is kept
  const sameBatch = (r: Run) => r.date === entry.date && JSON.stringify(r.days) === JSON.stringify(entry.days);
  const runs = journal().filter((r) => !sameBatch(r));
  for (const p of (entry.new_patterns ?? []) as PatternDef[])
    defs[p.id] ??= { id: p.id, label: p.label, kind: p.kind, rule: p.rule };
  delete entry.new_patterns;
  const wc = entry.word_count || 0;
  entry.error_rate = wc ? Math.round(entry.findings.length * 100 / wc * 100) / 100 : null;
  const now = new Date();
  entry.recorded_at = `${isoDate(now)}T${[now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join(":")}`;
  runs.push(entry);
  const y = yesterday();
  const done = coveredDays(runs);
  entry.backlog_days_left = [...allPrompts(config()).keys()].filter((d) => d <= y && !done.has(d)).length;
  runs.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(JOURNAL, runs.map((r) => jsonLine(r) + "\n").join(""));
  writeFileSync(PATTERNS, JSON.stringify(defs, null, 1) + "\n");
  console.log(`recorded ${entry.date} (${(entry.days ?? []).join(", ") || "no days"}): ` +
    `${entry.findings.length} findings, ${(entry.vocabulary ?? []).length} vocab`);
}

function cmdRender(runDate?: string) {
  const runs = journal();
  if (!runs.length) die("render: nothing recorded yet");
  const idx = runDate ? runs.findLastIndex((r) => r.date === runDate) : runs.length - 1;
  if (idx < 0) die(`render: no review for ${runDate}`);
  const run = runs[idx], upto = runs.slice(0, idx + 1), before = runs.slice(0, idx);
  const defs = loadJson<Record<string, PatternDef>>(PATTERNS, {});
  const stats = Object.fromEntries(patternStats(upto, defs).map((s) => [s.id, s]));
  const prev = Object.fromEntries(patternStats(before, defs).map((s) => [s.id, s]));
  const hit = new Set(run.findings.map((f) => f.pattern_id));
  const data = {
    run,
    patterns: stats,
    repeats: [...hit].filter((pid) => pid && prev[pid]?.count),
    wins: Object.values(stats).filter((s) => (s.status === "improving" || s.status === "mastered")
      && prev[s.id]?.status !== s.status),
    trend: upto.slice(-14).map((r) => ({ date: r.date, error_rate: r.error_rate ?? null })),
    backlog_days_left: run.backlog_days_left ?? null,
    search_cmd: `bun ${tilde(join(CODE, "coach.ts"))} search <word>`,
  };
  const blob = JSON.stringify(data).replaceAll("</", "<\\/");
  mkdirSync(dirname(PAGE), { recursive: true });
  writeFileSync(PAGE, readFileSync(TEMPLATE, "utf8").replace("/*__DATA__*/null", () => blob));
  console.log(PAGE);
}

function cmdSearch(term: string) {
  const t = term.toLowerCase();
  let hits = 0;
  for (const r of journal()) {
    for (const f of [...(r.findings ?? []), ...(r.vocabulary ?? [])] as Json[]) {
      if (!JSON.stringify(f).toLowerCase().includes(t)) continue;
      hits += 1;
      if ("use" in f) console.log(`${r.date}  vocab       ${f.instead_of} -> ${f.use}   e.g. ${f.example}`);
      else console.log(`${r.date}  ${f.kind.padEnd(11)} ${repr(f.original)} -> ${repr(f.corrected)}   [${f.pattern_id || "-"}]`);
    }
  }
  for (const p of Object.values(loadJson<Record<string, PatternDef>>(PATTERNS, {}))) {
    if (!JSON.stringify(p).toLowerCase().includes(t)) continue;
    hits += 1;
    console.log(`pattern     ${p.id}: ${p.label} (${p.rule})`);
  }
  if (!hits) console.log(`nothing found for ${repr(term)}`);
}

function cmdPatterns(all: boolean) {
  for (const s of patternStats(journal(), loadJson(PATTERNS, {}))) {
    if (s.status === "mastered" && !all) continue;
    console.log(`${s.status.padEnd(9)} x${String(s.count).padEnd(3)} ${s.runs_seen} reviews  ${s.id}: ${s.label}  (last ${s.last_seen ?? "-"})`);
  }
}

function cmdStats() {
  const runs = journal();
  if (!runs.length) console.log("no reviews yet");
  for (const r of runs.slice(-14)) {
    const rate = r.error_rate;
    const days = r.days ?? [];
    const span = days.length > 1 ? `${days[0]}..${days.at(-1)}` : days[0] ?? "-";
    console.log(`${r.date}  ${span.padEnd(22)} ${String(r.prompt_count).padStart(3)} prompts  ${String(rate ?? "-").padStart(5)}/100w  ${r.headline}`);
  }
}

function cmdBacklog() {
  const cfg = config(), runs = journal();
  const done = coveredDays(runs);
  const rows = [...allPrompts(cfg).entries()].sort(([a], [b]) => a.localeCompare(b)).filter(([d]) => !done.has(d));
  for (const [d, ps] of rows) console.log(`${d}  ${String(ps.length).padStart(4)}`);
  console.log(`${rows.length} unreviewed days, ${rows.reduce((n, [, ps]) => n + ps.length, 0)} prompts`);
}

function cmdSetUrl(url: string) {
  const cfg = loadJson<Record<string, Json>>(CONFIG, {});
  cfg.artifact_url = url;
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 1) + "\n");
  console.log(`artifact_url = ${url}`);
}

function usage(code = 0): never {
  (code ? console.error : console.log)(`usage: coach.ts <command> [options]\n\n${DOC}`);
  process.exit(code);
}

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") usage(cmd ? 0 : 2);
  const parse = <O extends ParseArgsOptionsConfig>(options: O, positionals = 0) => {
    try {
      const r = parseArgs({ args: rest, options, allowPositionals: positionals !== 0 });
      if (positionals > 0 && r.positionals.length !== positionals) throw new Error(`expected ${positionals} argument(s)`);
      if (positionals < 0 && !r.positionals.length) throw new Error("expected at least one argument");
      return r;
    } catch (e: any) {
      console.error(`coach.ts ${cmd}: ${e.message}`);
      process.exit(2);
    }
  };
  const days = { date: { type: "string" }, since: { type: "string" }, until: { type: "string" } } as const;
  switch (cmd) {
    case "context": return cmdContext(parse(days).values);
    case "prompts": return cmdPrompts(parse({ ...days, text: { type: "boolean" } }).values);
    case "record": return cmdRecord(parse({}, 1).positionals[0]);
    case "render": return cmdRender(parse({ run: { type: "string" } }).values.run);
    case "search": return cmdSearch(parse({}, 1).positionals[0]);
    case "patterns": return cmdPatterns(!!parse({ all: { type: "boolean" } }).values.all);
    case "stats": parse({}); return cmdStats();
    case "backlog": parse({}); return cmdBacklog();
    case "set-url": return cmdSetUrl(parse({}, 1).positionals[0]);
    case "used": return cmdUsed(parse({}, -1).positionals);
    default: usage(2);
  }
}

await main();
