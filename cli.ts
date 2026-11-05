#!/usr/bin/env bun
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import * as coach from "./coach";
import { cmdInstall, cmdRun, cmdUninstall } from "./setup";

const DOC = `english-peer: a daily review of the English in the prompts you type into Claude Code.

Setup:
  install  [--time HH:MM] [--language L]        daily job at 08:30, native language Spanish; rerun to change
  uninstall                                     remove the daily job, keep your reviews
  run      [--force]                            review now (what the daily job runs); --force for an extra batch

Look things up:
  search   TERM                                 grep findings, vocab and patterns
  patterns [--all]                              recurring mistakes with stats
  stats                                         last 14 reviews
  backlog                                       unreviewed days with prompt counts
  used     WORD [WORD...]                       how often I've written each word/phrase, ever

Used by the review session:
  context  [--date D | --since D [--until D]]   everything the daily run needs, as JSON
  prompts  [--date D | --since D [--until D]] [--text]
  record   FILE.json | -                        validate + append a review, merge new patterns
  render   [--run DATE]                         build the artifact page for a review
  set-url  URL                                  remember the artifact link for later runs

Data (in $ENGLISH_PEER_DATA, default ~/.local/share/english-peer):
  journal.jsonl   one line per review run (append-only, greppable)
  patterns.json   recurring mistakes: definitions; stats are derived from the journal
  config.json     native language, model, artifact url, filters, batch sizes
  logs/           one log per day

Day selection (no flags): unreviewed days, newest first, starting with
yesterday. Older days are added until the batch has \`target_prompts\`,
without going past \`max_prompts\`. A quiet day therefore pulls in backlog,
and the history before the first run gets worked through over time.`;

function usage(code = 0): never {
  (code ? console.error : console.log)(`usage: english-peer <command> [options]\n\n${DOC}`);
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
      console.error(`english-peer ${cmd}: ${e.message}`);
      process.exit(2);
    }
  };
  const days = { date: { type: "string" }, since: { type: "string" }, until: { type: "string" } } as const;
  switch (cmd) {
    case "install": return cmdInstall(parse({ time: { type: "string" }, language: { type: "string" } }).values);
    case "uninstall": parse({}); return cmdUninstall();
    case "run": return cmdRun(!!parse({ force: { type: "boolean" } }).values.force);
    case "search": return coach.cmdSearch(parse({}, 1).positionals[0]);
    case "patterns": return coach.cmdPatterns(!!parse({ all: { type: "boolean" } }).values.all);
    case "stats": parse({}); return coach.cmdStats();
    case "backlog": parse({}); return coach.cmdBacklog();
    case "used": return coach.cmdUsed(parse({}, -1).positionals);
    case "context": return coach.cmdContext(parse(days).values);
    case "prompts": return coach.cmdPrompts(parse({ ...days, text: { type: "boolean" } }).values);
    case "record": return coach.cmdRecord(parse({}, 1).positionals[0]);
    case "render": return coach.cmdRender(parse({ run: { type: "string" } }).values.run);
    case "set-url": return coach.cmdSetUrl(parse({}, 1).positionals[0]);
    default: usage(2);
  }
}

await main();
