#!/usr/bin/env python3
"""english-peer: pulls the prompts you typed into Claude Code and keeps a
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
yesterday. Older days are added until the batch has `target_prompts`,
without going past `max_prompts`. A quiet day therefore pulls in backlog,
and the history before the first run gets worked through over time.
"""
import argparse, collections, datetime as dt, json, os, re, sys
from pathlib import Path

CODE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("ENGLISH_PEER_DATA", Path.home() / ".local" / "share" / "english-peer"))
HISTORY = Path.home() / ".claude" / "history.jsonl"
JOURNAL = DATA / "journal.jsonl"
PATTERNS = DATA / "patterns.json"
CONFIG = DATA / "config.json"
TEMPLATE = CODE / "template.html"
PAGE = DATA / "out" / "english-peer.html"

# The daily run's own prompt carries this marker so it never reviews itself.
RUN_MARKER = "ENGLISH-COACH-RUN"
PLACEHOLDER = re.compile(r"\[(Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]")
KINDS = {"grammar", "vocabulary", "phrasing", "punctuation", "tone"}
# everyday verbs I lean on; the coach suggests sharper ones
WEAK_VERBS = ["do", "make", "check", "see", "get", "put", "give", "take", "fix", "run", "use",
              "try", "look", "have", "want", "need", "say", "tell", "show", "change", "go", "work"]
LEARN_FIELDS = {
    "verbs": ("verb", "meaning", "example"),
    "phrasal_verbs": ("phrase", "meaning", "example"),
    "words": ("word", "meaning", "example"),
    "alternatives": ("you_wrote", "options"),
}
MASTERED_AFTER_RUNS = 14  # pattern absent from this many later reviews -> mastered
IMPROVING_AFTER_RUNS = 3


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def config():
    return {
        "artifact_url": None,
        "ignore_project_prefixes": ["/private/tmp", "/tmp"],
        # canned prompts from automations / templates, not written by me
        "ignore_prompts_containing": [],
        "min_words": 3,
        "target_prompts": 60,
        "max_prompts": 250,
        **load_json(CONFIG, {}),
    }


def journal():
    if not JOURNAL.exists():
        return []
    return sorted((json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()), key=lambda d: d["date"])


def covered_days(runs):
    return {day for r in runs for day in r.get("days", [])}


def clean(text):
    text = PLACEHOLDER.sub(" ", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def all_prompts(cfg):
    """Every prompt I typed, cleaned and filtered, grouped by local date."""
    by_day, seen = collections.defaultdict(list), set()
    for line in HISTORY.read_text().splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        project = r.get("project") or ""
        if any(project.startswith(p) for p in cfg["ignore_project_prefixes"]):
            continue
        raw = r.get("display") or ""
        if raw.startswith("!") or any(m in raw for m in [RUN_MARKER, *cfg["ignore_prompts_containing"]]):
            continue
        if raw.startswith("/"):  # keep the free text after a slash command, drop the command
            raw = (raw.split(maxsplit=1) + [""])[1]
        text = clean(raw)
        if len(text.split()) < cfg["min_words"] or text in seen:  # "ok", "yes", resubmits
            continue
        seen.add(text)
        ts = dt.datetime.fromtimestamp(r["timestamp"] / 1000)
        by_day[ts.date().isoformat()].append({
            "id": f"{ts:%Y%m%d-%H%M%S}",
            "time": f"{ts:%Y-%m-%d %H:%M}",
            "project": project.replace(str(Path.home()), "~"),
            "text": text,
        })
    return by_day


def select_days(args, by_day, runs, cfg):
    if args.date:
        return [args.date]
    if args.since:
        until = args.until or dt.date.today().isoformat()
        return sorted(d for d in by_day if args.since <= d <= until)
    yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    done = covered_days(runs)
    picked, total = [], 0
    for day in sorted((d for d in by_day if d <= yesterday and d not in done), reverse=True):
        n = len(by_day[day])
        if picked and total + n > cfg["max_prompts"]:
            continue  # too big for this batch; a later quiet day will pick it up
        picked.append(day)
        total += n
        if total >= cfg["target_prompts"]:
            break
    return sorted(picked)


def prompts_for(days, by_day):
    return [p for d in days for p in by_day.get(d, [])]


def pattern_stats(runs, defs):
    # runs are counted by position, since one day can hold several runs
    stats = {pid: {**p, "count": 0, "runs": [], "examples": []} for pid, p in defs.items()}
    for i, r in enumerate(runs):
        for f in r.get("findings", []):
            s = stats.get(f.get("pattern_id"))
            if not s:
                continue
            s["count"] += 1
            if i not in s["runs"]:
                s["runs"].append(i)
            s["examples"].append({"date": r["date"], "original": f["original"], "corrected": f["corrected"]})
    for s in stats.values():
        s["examples"] = s["examples"][-3:]
        s["first_seen"] = runs[s["runs"][0]]["date"] if s["runs"] else None
        s["last_seen"] = runs[s["runs"][-1]]["date"] if s["runs"] else None
        since = len(runs) - 1 - s["runs"][-1] if s["runs"] else 0
        s["runs_since_last_seen"] = since
        s["status"] = ("new" if not s["runs"] else "mastered" if since >= MASTERED_AFTER_RUNS
                       else "improving" if since >= IMPROVING_AFTER_RUNS else "active")
        s["runs_seen"] = len(s.pop("runs"))
    return sorted(stats.values(), key=lambda s: (s["status"] == "mastered", -s["count"]))


def taught(runs):
    """Everything already suggested, lowercased, so it isn't suggested again."""
    out = {v["use"].lower() for r in runs for v in r.get("vocabulary", [])}
    for r in runs:
        for key, fields in LEARN_FIELDS.items():
            if key != "alternatives":
                out |= {i[fields[0]].lower() for i in r.get("learn", {}).get(key, [])}
    return sorted(out)


def word_counts(texts, words):
    counts = {}
    for w in words:
        rx = re.compile(r"\b" + re.escape(w.lower()) + r"\b")
        counts[w] = sum(len(rx.findall(t.lower())) for t in texts)
    return counts


def cmd_used(args):
    texts = [p["text"] for ps in all_prompts(config()).values() for p in ps]
    for w, n in word_counts(texts, args.words).items():
        print(f"{n:>5}  {w}")


def cmd_prompts(args):
    cfg, runs = config(), journal()
    by_day = all_prompts(cfg)
    days = select_days(args, by_day, runs, cfg)
    prompts = prompts_for(days, by_day)
    if args.text:
        for p in prompts:
            print(f"[{p['id']}] {p['text']}\n")
    else:
        print(json.dumps({"days": days, "prompts": prompts}, indent=1, ensure_ascii=False))


def cmd_context(args):
    cfg, runs = config(), journal()
    by_day = all_prompts(cfg)
    days = select_days(args, by_day, runs, cfg)
    prompts = prompts_for(days, by_day)
    yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    backlog = [d for d in by_day if d <= yesterday and d not in covered_days(runs) and d not in days]
    stats = pattern_stats(runs, load_json(PATTERNS, {}))
    print(json.dumps({
        "run_date": dt.date.today().isoformat(),
        "days": days,
        "includes_backlog": bool(days) and (days[-1] != yesterday or len(days) > 1),
        "backlog_days_left": len(backlog),
        "artifact_url": cfg["artifact_url"],
        "prompt_count": len(prompts),
        "word_count": sum(len(p["text"].split()) for p in prompts),
        "prompts": prompts,
        "patterns": [{k: s[k] for k in ("id", "label", "kind", "rule", "status", "count", "runs_seen", "last_seen", "examples")}
                     for s in stats if s["status"] != "mastered"],
        "mastered_patterns": [s["id"] for s in stats if s["status"] == "mastered"],
        "recent_runs": [{"date": r["date"], "days": r.get("days"), "error_rate": r.get("error_rate"), "headline": r.get("headline"),
                         "pattern_ids": sorted({f["pattern_id"] for f in r.get("findings", []) if f.get("pattern_id")})}
                        for r in runs[-7:]],
        "already_taught": taught(runs),
        "weak_verb_counts": {w: n for w, n in sorted(word_counts([p["text"] for p in prompts], WEAK_VERBS).items(),
                                                     key=lambda kv: -kv[1]) if n},
    }, indent=1, ensure_ascii=False))


def validate(entry, defs):
    errs = []
    for key in ("date", "days", "prompt_count", "word_count", "headline", "findings"):
        if key not in entry:
            errs.append(f"missing '{key}'")
    new_ids = {p.get("id") for p in entry.get("new_patterns", [])}
    for i, f in enumerate(entry.get("findings", [])):
        for key in ("kind", "original", "corrected", "why"):
            if not f.get(key):
                errs.append(f"findings[{i}] missing '{key}'")
        if f.get("kind") and f["kind"] not in KINDS:
            errs.append(f"findings[{i}].kind '{f['kind']}' not in {sorted(KINDS)} (typos are not recorded)")
        pid = f.get("pattern_id")
        if pid and pid not in defs and pid not in new_ids:
            errs.append(f"findings[{i}].pattern_id '{pid}' unknown: add it to new_patterns")
    shown = [f for f in entry.get("findings", []) if f.get("show")]
    if entry.get("findings") and not 1 <= len(shown) <= 7:
        errs.append(f"mark 1-7 findings with \"show\": true for the page (got {len(shown)})")
    for i, p in enumerate(entry.get("new_patterns", [])):
        for key in ("id", "label", "kind", "rule"):
            if not p.get(key):
                errs.append(f"new_patterns[{i}] missing '{key}'")
        if p.get("id") and not re.fullmatch(r"[a-z0-9-]+", p["id"]):
            errs.append(f"new_patterns[{i}].id must be kebab-case")
    for key, items in entry.get("learn", {}).items():
        if key not in LEARN_FIELDS:
            errs.append(f"learn.{key} unknown; use {sorted(LEARN_FIELDS)}")
            continue
        if len(items) > 3:
            errs.append(f"learn.{key} has {len(items)} items; max 3 to keep the page short")
        for i, item in enumerate(items):
            for field in LEARN_FIELDS[key]:
                if not item.get(field):
                    errs.append(f"learn.{key}[{i}] missing '{field}'")
    for i, v in enumerate(entry.get("vocabulary", [])):
        for key in ("instead_of", "use", "example"):
            if not v.get(key):
                errs.append(f"vocabulary[{i}] missing '{key}'")
    return errs


def cmd_record(args):
    entry = json.loads(sys.stdin.read() if args.file == "-" else Path(args.file).read_text())
    defs = load_json(PATTERNS, {})
    errs = validate(entry, defs)
    if errs:
        sys.exit("record: invalid entry\n  " + "\n  ".join(errs))
    # re-recording the same batch replaces it; a second batch on the same day is kept
    runs = [r for r in journal() if (r["date"], r.get("days")) != (entry["date"], entry["days"])]
    for p in entry.pop("new_patterns", []):
        defs.setdefault(p["id"], {k: p[k] for k in ("id", "label", "kind", "rule")})
    words = entry["word_count"] or 0
    entry["error_rate"] = round(len(entry["findings"]) * 100 / words, 2) if words else None
    entry["recorded_at"] = dt.datetime.now().isoformat(timespec="seconds")
    runs.append(entry)
    yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    done = covered_days(runs)
    entry["backlog_days_left"] = len([d for d in all_prompts(config()) if d <= yesterday and d not in done])
    runs.sort(key=lambda r: r["date"])
    JOURNAL.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in runs))
    PATTERNS.write_text(json.dumps(defs, indent=1, ensure_ascii=False) + "\n")
    print(f"recorded {entry['date']} ({', '.join(entry['days']) or 'no days'}): "
          f"{len(entry['findings'])} findings, {len(entry.get('vocabulary', []))} vocab")


def cmd_render(args):
    runs = journal()
    if not runs:
        sys.exit("render: nothing recorded yet")
    idx = max((i for i, r in enumerate(runs) if r["date"] == args.run), default=None) if args.run else len(runs) - 1
    if idx is None:
        sys.exit(f"render: no review for {args.run}")
    run, upto, before = runs[idx], runs[:idx + 1], runs[:idx]
    stats = {s["id"]: s for s in pattern_stats(upto, load_json(PATTERNS, {}))}
    prev = {s["id"]: s for s in pattern_stats(before, load_json(PATTERNS, {}))}
    hit = {f.get("pattern_id") for f in run["findings"]}
    data = {
        "run": run,
        "patterns": stats,
        "repeats": [pid for pid in hit if pid in prev and prev[pid]["count"]],
        "wins": [s for s in stats.values() if s["status"] in ("improving", "mastered")
                 and prev.get(s["id"], {}).get("status") != s["status"]],
        "trend": [{"date": r["date"], "error_rate": r.get("error_rate")} for r in upto[-14:]],
        "backlog_days_left": run.get("backlog_days_left"),
        "search_cmd": f"python3 {str(CODE / 'coach.py').replace(str(Path.home()), '~')} search <word>",
    }
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    PAGE.parent.mkdir(exist_ok=True)
    PAGE.write_text(TEMPLATE.read_text().replace("/*__DATA__*/null", blob))
    print(PAGE)


def cmd_search(args):
    term, hits = args.term.lower(), 0
    for r in journal():
        for f in r.get("findings", []) + r.get("vocabulary", []):
            if term in json.dumps(f, ensure_ascii=False).lower():
                hits += 1
                if "use" in f:
                    print(f"{r['date']}  vocab       {f['instead_of']} -> {f['use']}   e.g. {f['example']}")
                else:
                    print(f"{r['date']}  {f['kind']:<11} {f['original']!r} -> {f['corrected']!r}   [{f.get('pattern_id') or '-'}]")
    for p in load_json(PATTERNS, {}).values():
        if term in json.dumps(p, ensure_ascii=False).lower():
            hits += 1
            print(f"pattern     {p['id']}: {p['label']} ({p['rule']})")
    if not hits:
        print(f"nothing found for {args.term!r}")


def cmd_patterns(args):
    for s in pattern_stats(journal(), load_json(PATTERNS, {})):
        if s["status"] == "mastered" and not args.all:
            continue
        print(f"{s['status']:<9} x{s['count']:<3} {s['runs_seen']} reviews  {s['id']}: {s['label']}  (last {s['last_seen']})")


def cmd_stats(args):
    runs = journal()
    if not runs:
        print("no reviews yet")
    for r in runs[-14:]:
        rate = r.get("error_rate")
        days = r.get("days") or []
        span = f"{days[0]}..{days[-1]}" if len(days) > 1 else (days[0] if days else "-")
        print(f"{r['date']}  {span:<22} {r['prompt_count']:>3} prompts  {rate if rate is not None else '-':>5}/100w  {r['headline']}")


def cmd_backlog(args):
    cfg, runs = config(), journal()
    done = covered_days(runs)
    rows = [(d, len(p)) for d, p in sorted(all_prompts(cfg).items()) if d not in done]
    for d, n in rows:
        print(f"{d}  {n:>4}")
    print(f"{len(rows)} unreviewed days, {sum(n for _, n in rows)} prompts")


def cmd_set_url(args):
    cfg = load_json(CONFIG, {})
    cfg["artifact_url"] = args.url
    CONFIG.write_text(json.dumps(cfg, indent=1) + "\n")
    print(f"artifact_url = {args.url}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("context", cmd_context), ("prompts", cmd_prompts)):
        p = sub.add_parser(name)
        p.add_argument("--date")
        p.add_argument("--since")
        p.add_argument("--until")
        if name == "prompts":
            p.add_argument("--text", action="store_true")
        p.set_defaults(fn=fn)
    p = sub.add_parser("record"); p.add_argument("file"); p.set_defaults(fn=cmd_record)
    p = sub.add_parser("render"); p.add_argument("--run"); p.set_defaults(fn=cmd_render)
    p = sub.add_parser("search"); p.add_argument("term"); p.set_defaults(fn=cmd_search)
    p = sub.add_parser("patterns"); p.add_argument("--all", action="store_true"); p.set_defaults(fn=cmd_patterns)
    p = sub.add_parser("stats"); p.set_defaults(fn=cmd_stats)
    p = sub.add_parser("backlog"); p.set_defaults(fn=cmd_backlog)
    p = sub.add_parser("set-url"); p.add_argument("url"); p.set_defaults(fn=cmd_set_url)
    p = sub.add_parser("used"); p.add_argument("words", nargs="+"); p.set_defaults(fn=cmd_used)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
