# english-peer

A daily review of the English you write to Claude Code, built for non-native
speakers. Every morning it reads the prompts you typed the day before and
opens a page you can read in five minutes. The page covers grammar fixes,
mistakes you keep repeating, better verbs, phrasal verbs, new words, a verb
tense or conditional you rarely use, and other ways to say what you wrote. Typos are ignored.

## Install

    bun link                                          # puts `english-peer` on your PATH
    english-peer install                              # daily at 08:30, native language Spanish
    english-peer install --time 09:00 --language Portuguese

Requirements: macOS, [Bun](https://bun.sh), and the Claude Code CLI installed and logged in.

Run `install` again to change the time or language. Pulling new code needs
nothing else, since the command runs straight from this folder. To remove the
daily job without deleting your reviews:

    english-peer uninstall

## How it works

- **Schedule:** a launchd job runs `english-peer run` at the chosen time. If the Mac is
  asleep then, it runs on wake. It also runs at login, so days when the Mac
  was shut down aren't skipped. It reviews at most once a day.
- **Prompts:** `english-peer` reads `~/.claude/history.jsonl`, which only contains
  the prompts you typed. It skips pasted text, images, shell commands, short
  replies like "ok", and runs under `/tmp`. Each review starts with yesterday.
  If there are fewer than 150 prompts, it adds older unreviewed days until it
  reaches 150, without going over 300. Over time this works through your
  whole history.
- **Analysis:** an unattended `claude -p` session analyzes the prompts using
  `PROMPT.md` and records every real error. Mistakes that keep coming back
  become patterns, each marked as active, improving or mastered.
- **The page:** it's built from the fixed `template.html`, so it looks the
  same every day. It opens in your browser, along with a notification showing
  the day's headline.

## Your data

Everything lives in `~/.local/share/english-peer`. Set `ENGLISH_PEER_DATA`
to change the location.

| File | What |
|---|---|
| `journal.jsonl` | one line per review: every finding, word and rewrite |
| `patterns.json` | your recurring mistakes |
| `config.json` | native language, model, filters, batch sizes |
| `out/` | one page per review, `2026-11-06.html`; older pages are never overwritten |
| `logs/` | one log per day |

## Commands

    english-peer search advise     # look up any past correction, word or pattern
    english-peer patterns          # recurring mistakes and their status
    english-peer stats             # the last 14 reviews
    english-peer backlog           # days not reviewed yet
    english-peer used tackle       # how often you've written a word
    english-peer open 2026-11-05   # reopen an older day's page (no date: the latest)
    english-peer run --force       # run an extra review today
    english-peer --help            # everything else

To skip prompts that come from automations rather than your own typing, add a
snippet of their text to `ignore_prompts_containing` in `config.json`.

## Development

`cli.ts` is the command, `coach.ts` holds the review commands and `setup.ts`
the daily job. `bun install && bun run typecheck` checks the types.
