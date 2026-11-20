// Fetches Lichess's daily puzzle and writes a cache file the mod UI reads:
//   cache/YYYY-MM-DD.json  { date, id, rating, themes, turn, fen, board, lastMove, solution }
//
// Run by hand:  node fetch_puzzle.mjs
// Run by the mod UI: exec("node", [<mod dir>/fetch_puzzle.mjs], { cwd: <mod dir> })
//
// The PGN is replayed with the pure logic in ./chess.js (no dependency). Lichess's
// `puzzle.initialPly` is 0-indexed; the position to try first is `initialPly + 1`
// half-moves. If `solution[0]` is not legal there, +/-1 half-move is tried before
// giving up. Dates are UTC — Lichess's daily puzzle rolls over at UTC midnight.

import {
  existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLegalUci, replaySan } from "./chess.js";

export const PUZZLE_URL = "https://lichess.org/api/puzzle/daily";
const PRUNE_DAYS = 30;

/** Today's date, UTC, as YYYY-MM-DD. The UI uses the same rule. */
export function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function defaultCacheDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cache");
}

/** Fetches the daily puzzle and writes today's cache file.
 *  Injectable arguments (used by the tests): fetchFn, today, cacheDir.
 *  Resolves { ok: true, file, cached } or throws an Error with a short message. */
export async function run({
  fetchFn = fetch,
  today = utcToday(),
  cacheDir = defaultCacheDir(),
  timeout = 10_000,
} = {}) {
  const file = path.join(cacheDir, `${today}.json`);
  if (existsSync(file)) return { ok: true, cached: true, file };

  let res;
  try {
    res = await fetchFn(PUZZLE_URL, {
      headers: { "User-Agent": "herdr-lichess-daily (local Herdr mod)" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`could not reach ${PUZZLE_URL}: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new Error(`lichess API returned HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("lichess API returned invalid JSON");
  }
  const puzzle = data?.puzzle;
  if (!puzzle || typeof puzzle.id !== "string" || !Array.isArray(puzzle.solution) || !puzzle.solution.length
    || typeof data?.game?.pgn !== "string") {
    throw new Error("malformed response: missing puzzle fields");
  }

  const position = findPosition(data.game.pgn, puzzle);
  const out = {
    date: today,
    id: puzzle.id,
    rating: typeof puzzle.rating === "number" ? puzzle.rating : null,
    themes: Array.isArray(puzzle.themes) ? puzzle.themes : [],
    turn: position.turn,
    fen: position.fen,
    board: position.board,
    lastMove: position.lastMove,
    solution: puzzle.solution,
  };

  mkdirSync(cacheDir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, file);
  prune(cacheDir, today);
  return { ok: true, cached: false, file };
}

/** Replays the PGN so that `solution[0]` is a legal move for the side to move.
 *  Tries initialPly + 1 half-moves first, then +/-1. */
function findPosition(pgn, puzzle) {
  const base = typeof puzzle.initialPly === "number" ? puzzle.initialPly : 0;
  let firstError = null;
  for (const off of [0, -1, 1]) {
    const plies = base + 1 + off;
    try {
      const pos = replaySan(pgn, plies);
      if (isLegalUci(pos, puzzle.solution[0])) return pos;
      if (!firstError) firstError = new Error(`solution[0] ${puzzle.solution[0]} is not legal after ${plies} half-moves`);
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  throw firstError ?? new Error("could not replay the PGN to the puzzle start");
}

/** Deletes cache files older than PRUNE_DAYS (today's file is never touched). */
function prune(cacheDir, today) {
  let names;
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name) || name === `${today}.json`) continue;
    try {
      if (statSync(path.join(cacheDir, name)).mtimeMs < cutoff) unlinkSync(path.join(cacheDir, name));
    } catch {
      // best effort
    }
  }
}

// Entry point: only when executed directly, not when the tests import this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((r) => {
      console.error(`${r.cached ? "cache hit" : "fetched"}: ${r.file}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`lichess-daily: ${err?.message ?? err}`);
      process.exit(1);
    });
}
