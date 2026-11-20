# lichess-daily (Herdr mod)

A Herdr pane with Lichess's daily chess puzzle. A small Node fetcher caches the
puzzle once a day; the GPUI board lets you play through the solution, with a
Hint, a Reset and an Open on Lichess button.

```
lichess-daily/
  mod.json          { "title": "Lichess Daily", "place": "right", "size": 400 }
  main.js           the GPUI view (board, state machine, buttons)
  chess.js          pure chess logic shared by the fetcher and the UI
  fetch_puzzle.mjs  fetches https://lichess.org/api/puzzle/daily, writes cache/
  cache/            one JSON per day: { date, id, rating, themes, turn, fen,
                    board, lastMove, solution }  (gitignored)
```

## Install

```sh
./install.sh          # symlinks the repo folder into ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/lichess-daily
```

A symlink works (Herdr follows it); `./install.sh copy` makes a plain copy
instead if you ever prefer one.

## Add it to the layout

The first time Herdr sees the folder it docks one copy per `mod.json` into the
shown layout. To pin it as a tab in the hidden right panel stack, add a block to
the `panel-body` stack in `layouts/Herdr-Roundup.json`:

```json
{
  "id": "lichess-daily",
  "type": "block",
  "content": { "mod": "lichess-daily" }
}
```

## How it works

- On load the mod runs `node fetch_puzzle.mjs` (via `exec`, guarded by
  `checking()` so `herdr-app check` stays side-effect free), then reads
  `cache/<today>.json`. UTC dates everywhere — Lichess rolls the daily puzzle
  over at UTC midnight, and the mod reloads itself when the UTC date changes.
- Offline with no cache for today, the newest cached day is shown instead; with
  no cache at all, an error state with a Retry button.
- `solution[0]` is the player's first move; opponent replies sit at odd indexes
  and are auto-played 300 ms later. Clicks are ignored while a reply is pending.
- Castling, en passant and promotions in the solution are handled by
  `applyUciMove` in `chess.js`; the board is flipped when the player is Black.

## Known limits

- **Alternate mates are rejected.** Lichess accepts any move that mates; this
  version only accepts the exact solution moves. The help text in the pane says
  so.
- **Promotion choices.** A promotion defaults to the solution's piece — you
  cannot pick a different promotion piece yourself.
- **The fetcher needs Node on PATH.** `node` is tried first (exec uses your real
  environment), then `/opt/homebrew/bin/node` and `/usr/local/bin/node`.
- Cache files older than 30 days are pruned by the fetcher.

## Development

```sh
node --test "test/*.test.mjs"    # chess.js logic, fetcher (injectable fetch), fixtures
```

`test/fixtures/daily.json` is a recorded daily-puzzle response; the tests pin
down the `initialPly + 1` half-move replay and the ±1 fallback.
