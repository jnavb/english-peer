// The daily job: installing it in launchd, and the review run it starts each day.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODE, CONFIG, DATA, HOME, die, isoDate, journal, loadJson, pad, renderPage, today } from "./coach";

const LABEL = "com.english-peer.daily";
const PLIST = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const CLI = join(CODE, "cli.ts");
const LOCK = join(DATA, ".lock");
const DEFAULTS = {
  native_language: "Spanish",
  model: "opus",
  ignore_project_prefixes: ["/private/tmp", "/tmp"],
  ignore_prompts_containing: [],
  min_words: 3,
  target_prompts: 150,
  max_prompts: 300,
};
// launchd starts us with a bare PATH; claude, bun and Homebrew tools live here
const PATH = [process.env.PATH ?? "/usr/bin:/bin", dirname(process.execPath), join(HOME, ".bun", "bin"),
  join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");
const ENV = { ...process.env, PATH, ENGLISH_PEER_DATA: DATA };

const say = (msg: string) => console.log(`\x1b[34m==>\x1b[39m ${msg}`);
const bin = (name: string) => Bun.which(name, { PATH }) ?? name;
const sh = (...cmd: string[]) => Bun.spawnSync([bin(cmd[0]), ...cmd.slice(1)], { env: ENV });
const domain = () => `gui/${process.getuid!()}`;
const unload = () => sh("launchctl", "bootout", `${domain()}/${LABEL}`);
const reviewedToday = () => journal().some((r) => r.date === today());
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const stamp = (d = new Date()) => `${isoDate(d)} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join(":")}`;
const latestRun = () => journal().toSorted((a, b) => (a.recorded_at ?? "").localeCompare(b.recorded_at ?? "")).at(-1);

export function cmdInstall({ time = "08:30", language }: { time?: string; language?: string }) {
  if (process.platform !== "darwin") die("macOS only (uses launchd and notifications)");
  if (!Bun.which("claude", { PATH })) die("claude CLI not found; install Claude Code and log in first");
  const hm = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!hm) die(`--time must be HH:MM, got ${time}`);
  if (!existsSync(join(HOME, ".claude", "history.jsonl")))
    say("No ~/.claude/history.jsonl yet; reviews start once you've used Claude Code");

  // data dir and config (existing settings are kept)
  for (const dir of ["logs", "inbox", "out"]) mkdirSync(join(DATA, dir), { recursive: true });
  const cfg = { ...DEFAULTS, ...loadJson(CONFIG, {}) };
  if (language) cfg.native_language = language;
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 1) + "\n");
  say(`config: ${CONFIG} (native language: ${cfg.native_language}, model: ${cfg.model})`);

  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(CLI)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>ENGLISH_PEER_DATA</key><string>${xml(DATA)}</string></dict>
  <!-- daily; if the Mac is asleep then, launchd runs it on wake -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${Number(hm[1])}</integer><key>Minute</key><integer>${Number(hm[2])}</integer></dict>
  <!-- also at login, so a day the Mac was shut down isn't skipped -->
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${xml(join(DATA, "logs", "launchd.err"))}</string>
</dict>
</plist>
`);
  if (sh("plutil", "-lint", PLIST).exitCode) die(`generated ${PLIST} is invalid`);

  if (!reviewedToday()) say("No review yet today, so loading the job starts one now (a few minutes, then the page opens)");
  unload();
  const boot = sh("launchctl", "bootstrap", domain(), PLIST);
  if (boot.exitCode || sh("launchctl", "print", `${domain()}/${LABEL}`).exitCode)
    die(`launchd did not load ${LABEL}: ${boot.stderr.toString().trim()}`);
  say(`Installed. Daily review at ${time} (or on wake/login), data in ${DATA}`);
  say("Try: english-peer search <word>   |   english-peer run --force for an extra batch");
}

export function cmdUninstall() {
  unload();
  rmSync(PLIST, { force: true });
  say(`Daily job removed. Your reviews are still in ${DATA}`);
}

function notify(subtitle: string, message: string) {
  sh("osascript", "-e", "on run argv",
    "-e", 'display notification (item 2 of argv) with title "English Peer" subtitle (item 1 of argv) sound name "Glass"',
    "-e", "end run", subtitle, message);
}

async function waitForNetwork() {
  // right after login or wake the network may not be up yet
  for (let i = 0; i < 18; i++) {
    try {
      await fetch("https://api.anthropic.com", { signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      await Bun.sleep(10_000);
    }
  }
}

/** The daily review, started by launchd (see install). Reviews at most once a day unless forced. */
export async function cmdRun(force: boolean) {
  for (const dir of ["logs", "inbox"]) mkdirSync(join(DATA, dir), { recursive: true });
  // one recorded review per day is enough
  if (!force && reviewedToday()) return;
  // login and wake can fire together
  try {
    mkdirSync(LOCK);
  } catch {
    return console.error(`another review is running (remove ${LOCK} if it isn't)`);
  }
  const unlock = () => rmdirSync(LOCK);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { unlock(); process.exit(130); });

  const logPath = join(DATA, "logs", `${today()}.log`);
  const log = openSync(logPath, "a");
  const write = (line: string) => {
    writeSync(log, line + "\n");
    if (process.stdout.isTTY) console.log(line);
  };
  try {
    write(`== ${stamp()} start${process.stdout.isTTY ? ` (claude's output goes to ${logPath})` : ""}`);
    await waitForNetwork();
    const cfg = loadJson<Record<string, string>>(CONFIG, {});
    const prompt = readFileSync(join(CODE, "PROMPT.md"), "utf8")
      .replaceAll("__COACH__", CLI)
      .replaceAll("__INBOX__", join(DATA, "inbox"))
      .replaceAll("__NATIVE_LANGUAGE__", cfg.native_language ?? "Spanish");

    const before = latestRun()?.recorded_at;
    const claude = Bun.spawn([bin("claude"), "-p", prompt, "--model", cfg.model ?? "opus",
      "--allowedTools", `Bash(bun ${CLI}:*)`, "Read", `Edit(/${DATA}/inbox/**)`,
      "--permission-mode", "dontAsk"], { stdout: log, stderr: log, env: ENV });
    write(`== ${stamp()} exit ${await claude.exited}`);

    const latest = latestRun();
    if (latest && latest.recorded_at !== before) {
      sh("open", renderPage());
      notify("Today's review is open in your browser", latest.headline);
    } else {
      notify("No review recorded today", `See the log in ${join(DATA, "logs")}`);
    }
  } catch (e: any) {
    write(`== ${stamp()} error: ${e?.stack ?? e}`);
    notify("The review failed", `See the log in ${join(DATA, "logs")}`);
    process.exitCode = 1;
  } finally {
    closeSync(log);
    unlock();
  }
}
