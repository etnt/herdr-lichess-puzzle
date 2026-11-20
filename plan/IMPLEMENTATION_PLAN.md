# Implementation Plan: Lichess Daily Puzzle Mod for herdr-app

## Decisions made during implementation

- **Node, not Python.** `python-chess` is not installed and Node v24 is, so the
  fetcher is `fetch_puzzle.mjs` (a small pure-JS SAN replayer in `chess.js`, no
  dependency) and `fetch_puzzle.py` was never written. Fetcher and UI share one
  language and one `applyUciMove`. A `package.json` with `{ "type": "module" }`
  makes Node load `chess.js` as ESM; the GPUI runtime already does.
- **`mod.json` fields.** The real schema is `{ "title", "place", "size" }` —
  there is no `entry` field: Herdr loads `main.js` by convention and the folder
  name is the mod ID. `herdr-app check` confirmed it.
- **Open on Lichess** uses `cx.open_url(...)`, not an `open`/`xdg-open`
  subprocess (`gpui-kit.d.ts`: "Hands a URL to whatever the system opens URLs
  with").
- **Mod location.** The repo is the source of truth; the folder is symlinked
  into `~/.config/herdr-app/mods/lichess-daily` and `herdr-app check` passes
  through the symlink. `install.sh` falls back to copying if ever needed.
- **Day rollover** is UTC in both fetcher and UI; the UI re-checks the UTC date
  every minute and reloads when it changes.

## 0. Assumptions to Verify First

The plan relies on `herdr-app` mod details (`mod.json` schema, GPUI bindings, `herdr-app check`, layout config). Confirm each against the real Herdr docs before Phase 2. Adjust names and fields where they differ.

- **Python:** `python-chess` must be installed. If it is not, use the Node alternative (`chess.js`), or bundle a small pure-JS PGN replayer.
- **Network:** Only the fetch script needs the network. The UI reads the cache only.

## 1. Directory and File Structure

Create a folder in Herdr's mod directory: `~/.config/herdr-app/mods/lichess-daily/`.

| Path               | Purpose                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `mod.json`         | Mod metadata, entry point, default layout placement.                                          |
| `main.js`          | GPUI renderer, state machine, click handlers.                                                 |
| `fetch_puzzle.py`  | Fetches today's puzzle, replays the PGN to the start position, writes the cache.              |
| `cache/`           | Daily JSON files (`YYYY-MM-DD.json`). Avoids repeat API requests.                             |

## 2. Data Contract

Define the cache file first. Both `fetch_puzzle.py` and `main.js` depend on it.

```json
{
  "date": "2025-01-31",
  "id": "abc12",
  "rating": 1650,
  "themes": ["fork", "middlegame"],
  "turn": "white",
  "fen": "r1bqkbnr/... w KQkq - 0 5",
  "board": [["bR", null, "bB", "..."], "...8 rows of 8..."],
  "lastMove": ["e2", "e4"],
  "solution": ["d7d5", "e4d5", "d8d5"]
}
```

- `board[0]` is rank 8 (a8 to h8). `board[7]` is rank 1.
- `turn` is the side the player controls. The board is flipped when `turn` is `"black"`.
- `lastMove` is the opponent's setup move, for highlighting.
- `solution[0]` is the player's first move. Opponent replies are at odd indexes.
- Store `fen` as well. It is cheap and helps debugging and castling/en passant checks.

## 3. Implementation Phases

### Phase 1: Data and PGN Parser (`fetch_puzzle.py`)

1. **Check the daily cache.** If `cache/YYYY-MM-DD.json` exists, exit early with success.
2. **Fetch the data.** Send `GET https://lichess.org/api/puzzle/daily`. No auth token is needed. Set a timeout (about 10 s) and a `User-Agent` header.
3. **Replay the PGN to the start position.**
   - Load `game.pgn` with `python-chess`.
   - Play the moves up to the puzzle start, using `puzzle.initialPly` as the reference. Check the off-by-one: `initialPly` is 0-indexed, so the position may need `initialPly + 1` half-moves.
   - **Validate:** `solution[0]` must be a legal move in the resulting position. If it is not, try one half-move more or fewer. Fail with a clear error if neither works.
   - Record the last move played (`from`, `to`) as `lastMove`.
4. **Export normalized JSON** (see the data contract). Write to a temp file, then rename it. This avoids a half-written cache.
5. **Handle errors.** On network or parse failure, exit non-zero with a short message. If an older cache file exists, `main.js` may offer it as a fallback.
6. **Prune the cache.** Delete files older than about 30 days.

### Phase 2: Mod Manifest and Layout Hook (`mod.json`)

1. **Write `mod.json`.** Set the name, ID (`lichess-daily`), entry script (`main.js`), and preferred dock location (`"place": "right"`). Use the real schema from the Herdr docs.
2. **Register in the active layout.** Add `lichess-daily` to the active Herdr layout so it shows in a collapsible side pane that does not crowd terminal or agent panes.
3. **Trigger the fetch.** Decide who runs `fetch_puzzle.py`: the mod on startup (preferred, if Herdr lets mods spawn processes), or a manual or cron step.

### Phase 3: Board State and Puzzle Engine (`main.js`)

1. **State model:**

   ```js
   {
     status: "loading" | "playing" | "wrong" | "solved" | "error",
     board,          // current 8x8 matrix
     stepIndex,      // index into solution
     selectedSquare, // e.g. "g1", or null
     lastMove,       // highlighted [from, to]
     hintSquare,     // square highlighted by Hint, or null
     flipped         // true when the player is Black
   }
   ```

2. **Move helper `applyUciMove(board, uci)`.** Move the piece from `uci[0..2]` to `uci[2..4]`. Handle these special cases:
   - **Promotion:** `uci[4]` gives the new piece. Keep the pawn's colour.
   - **Castling:** A king moving two files (`e1g1`, `e1c1`, `e8g8`, `e8c8`) also moves the rook. Check that the moving piece is a king, so a rook or other piece on those squares is not misread.
   - **En passant:** A pawn moves diagonally onto an empty square. Remove the captured pawn on the origin rank, in the target file.
3. **Validation loop:**
   - On the second click, build `candidate = selectedSquare + targetSquare`.
   - If the player clicks another own piece, change the selection instead of validating.
   - Accept if `solution[stepIndex].startsWith(candidate)`. For promotions, default to a queen when the solution move has a promotion suffix and the candidate has none. (If the solution promotes to another piece, apply that piece.)
   - **Valid:** Apply the move, update `lastMove`, increment `stepIndex`. If solution moves remain, wait about 300 ms, auto-play the opponent's reply, and increment again. Ignore clicks during this delay. When `stepIndex === solution.length`, set `status = "solved"`.
   - **Invalid:** Set `status = "wrong"`, flash feedback, clear `selectedSquare`, and allow a retry. Return to `"playing"` after the flash.
   - **Alternate mates:** Lichess accepts any move that gives checkmate. Because the solution is a fixed list, a valid alternate mate is rejected. Accept this limit in v1 and note it in the UI help text. A later version can add a legal-move and mate check (for example, a small JS chess engine).

### Phase 4: GPUI Interface (`main.js`)

1. **Header bar.** Show the puzzle rating, a turn indicator ("White to move" or "Black to move"), and a status badge ("Loading...", "Try again", "Solved!", or an error message).
2. **8×8 board grid:**
   - Render 8 flex rows of 8 fixed-size squares (`div()`). Reverse row and column order when `flipped === true`.
   - Colour squares by parity `(row + col) % 2`. Override the tint for `selectedSquare`, `lastMove`, `hintSquare`, and the wrong flash.
   - Render Unicode glyphs (♔♕♖♗♘♙ white, ♚♛♜♝♞♟ black) centred in occupied squares. Check the font renders them at a good size. Use the filled glyphs for both colours with a text colour if the outline glyphs look weak.
   - Attach `.on_click` to each square for selection and move validation.
3. **Footer controls:**
   - **Hint:** Highlight `solution[stepIndex].slice(0, 2)`, the piece to move.
   - **Reset:** Reload the cached initial state for today's puzzle.
   - **Open on Lichess:** Run `open https://lichess.org/training/{id}` (`xdg-open` on Linux). Use the platform's open command and show the button after solving.

## 4. Verification and Testing

- **Static check:** Run `herdr-app check` to verify the `mod.json` schema and that `main.js` renders once without GPUI errors.
- **Unit tests for `applyUciMove`:** Test pure functions outside Herdr, for example with Node. Cover:
  - Black-to-move orientation.
  - White and black castling, both sides.
  - En passant.
  - Promotion, with and without capture.
- **Fixture puzzles:** Fetch known puzzles by ID (`GET /api/puzzle/{id}`) for each special case. Compare the parsed board and `solution[0]` legality against the expected result.
- **Fetch script tests:** Cover cache hit, network failure, malformed response, and the `initialPly` off-by-one check.
- **Offline resilience:** Disconnect the network after the first load. Restart `herdr-app` and confirm the cached puzzle loads. Also confirm that a missing cache while offline shows a clear error state.
- **Day rollover:** Confirm a new day triggers a new fetch. Decide which date to use (local or UTC) to match Lichess's daily puzzle change.

## 5. Next Steps

1. Verify the assumptions in section 0.
2. Generate the starter files: `mod.json`, `fetch_puzzle.py`, `main.js`.
3. Decide whether to use Python or Node for the PGN parser.
