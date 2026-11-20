// Tests for lichess-daily/fetch_puzzle.mjs — the fetch function is injectable,
// so nothing here touches the network or the real cache directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { run, utcToday } from "../lichess-daily/fetch_puzzle.mjs";
import { isLegalUci, parseFen } from "../lichess-daily/chess.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "daily.json");
const TODAY = utcToday(new Date("2026-02-03T21:40:00Z"));

function tmpCache() {
  return mkdtempSync(path.join(tmpdir(), "lichess-daily-test-"));
}

function fetchOk() {
  const body = readFileSync(FIXTURE, "utf8");
  return async () => ({ ok: true, status: 200, json: async () => JSON.parse(body) });
}

test("utcToday is UTC-based", () => {
  // 23:40 UTC is still "today"; 01:40 UTC the next day rolls over.
  assert.equal(utcToday(new Date("2026-02-03T23:40:00Z")), "2026-02-03");
  assert.equal(utcToday(new Date("2026-02-04T00:40:00Z")), "2026-02-04");
});

test("cache hit: no fetch happens and the existing file is returned", async () => {
  const dir = tmpCache();
  try {
    writeFileSync(path.join(dir, `${TODAY}.json`), "{}\n");
    let called = 0;
    const result = await run({
      fetchFn: async () => { called++; return fetchOk()(); },
      today: TODAY,
      cacheDir: dir,
    });
    assert.equal(called, 0);
    assert.deepEqual(result, { ok: true, cached: true, file: path.join(dir, `${TODAY}.json`) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("network failure: the error is short and carries the cause", async () => {
  const dir = tmpCache();
  try {
    await assert.rejects(
      run({
        fetchFn: async () => { throw new Error("getaddrinfo ENOTFOUND lichess.org"); },
        today: TODAY,
        cacheDir: dir,
      }),
      (err) => /ENOTFOUND/.test(err.message) && err.message.length < 200,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed response: missing puzzle fields is rejected", async () => {
  const dir = tmpCache();
  try {
    await assert.rejects(
      run({
        fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ foo: "bar" }) }),
        today: TODAY,
        cacheDir: dir,
      }),
      /malformed/,
    );
    await assert.rejects(
      run({
        fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
        today: TODAY,
        cacheDir: dir,
      }),
      /HTTP 503/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("success: writes the cache per the data contract (off-by-one validated)", async () => {
  const dir = tmpCache();
  try {
    const result = await run({ fetchFn: fetchOk(), today: TODAY, cacheDir: dir });
    assert.equal(result.cached, false);
    const data = JSON.parse(readFileSync(result.file, "utf8"));
    assert.equal(data.date, TODAY);
    assert.equal(data.id, "GjqO9");
    assert.ok(typeof data.rating === "number");
    assert.ok(Array.isArray(data.themes) && data.themes.length > 0);
    assert.ok(data.turn === "white" || data.turn === "black");
    assert.ok(Array.isArray(data.board) && data.board.length === 8 && data.board[0].length === 8);
    assert.ok(Array.isArray(data.lastMove) && data.lastMove.length === 2);
    assert.ok(Array.isArray(data.solution) && data.solution.length >= 3);
    // The written FEN must parse back to the written board, and the solution's
    // first move must be legal for the side to move.
    const fen = parseFen(data.fen);
    assert.deepEqual(fen.board, data.board);
    assert.equal(fen.turn, data.turn);
    assert.ok(isLegalUci({ board: data.board, turn: data.turn, castling: fen.castling, ep: fen.ep }, data.solution[0]));
    assert.throws(() => readFileSync(`${result.file}.tmp`), "no .tmp left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune: cache files older than 30 days are deleted", async () => {
  const dir = tmpCache();
  try {
    const old = path.join(dir, "2025-01-01.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(old, "{}\n");
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(old, oldTime, oldTime);
    await run({ fetchFn: fetchOk(), today: TODAY, cacheDir: dir });
    assert.throws(() => readFileSync(old), "old cache file pruned");
    assert.doesNotThrow(() => readFileSync(path.join(dir, `${TODAY}.json`)), "today's file kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
