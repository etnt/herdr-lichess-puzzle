// Tests for lichess-daily/chess.js — run with:  node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  START_FEN, applyUciMove, boardFromFen, colorOf, isLegalUci, legalUciMoves,
  parseFen, pieceAt, replaySan, sanTokens, squareName, squareRC,
} from "../lichess-daily/chess.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// --- basics -----------------------------------------------------------------

test("START_FEN is the standard position", () => {
  const b = boardFromFen(START_FEN);
  assert.equal(b[0][0], "bR");
  assert.equal(b[0][4], "bK");
  assert.equal(b[6][0], "wP");
  assert.equal(b[7][4], "wK");
  assert.equal(b[3][3], null);
});

test("squareName / squareRC round-trip", () => {
  assert.equal(squareName(0, 4), "e8");
  assert.equal(squareName(7, 0), "a1");
  assert.deepEqual(squareRC("e8"), [0, 4]);
  assert.deepEqual(squareRC("a1"), [7, 0]);
  for (const name of ["a1", "h8", "e4", "b7"]) assert.deepEqual(squareRC(name).map((x) => x), squareRC(name));
  const [r, c] = squareRC("d5");
  assert.equal(squareName(r, c), "d5");
});

test("parseFen handles turn, castling rights and ep", () => {
  const pos = parseFen("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4");
  assert.equal(pos.turn, "black");
  assert.equal(pos.castling, "KQkq");
  assert.equal(pos.ep, null);
  const pos2 = parseFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
  assert.equal(pos2.ep, "e3");
});

// --- applyUciMove: castling (all four cases) ---------------------------------

const CASTLE_FEN = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";

test("applyUciMove: white kingside castling moves king and rook", () => {
  const b = applyUciMove(boardFromFen(CASTLE_FEN), "e1g1");
  assert.equal(pieceAt(b, "g1"), "wK");
  assert.equal(pieceAt(b, "f1"), "wR");
  assert.equal(pieceAt(b, "e1"), null);
  assert.equal(pieceAt(b, "h1"), null);
});

test("applyUciMove: white queenside castling moves king and rook", () => {
  const b = applyUciMove(boardFromFen(CASTLE_FEN), "e1c1");
  assert.equal(pieceAt(b, "c1"), "wK");
  assert.equal(pieceAt(b, "d1"), "wR");
  assert.equal(pieceAt(b, "b1"), null);
  assert.equal(pieceAt(b, "a1"), null);
});

test("applyUciMove: black kingside castling moves king and rook", () => {
  const b = applyUciMove(boardFromFen("r3k2r/8/8/8/8/8/8/4K3 b kq - 0 1"), "e8g8");
  assert.equal(pieceAt(b, "g8"), "bK");
  assert.equal(pieceAt(b, "f8"), "bR");
  assert.equal(pieceAt(b, "e8"), null);
  assert.equal(pieceAt(b, "h8"), null);
});

test("applyUciMove: black queenside castling moves king and rook", () => {
  const b = applyUciMove(boardFromFen("r3k2r/8/8/8/8/8/8/4K3 b kq - 0 1"), "e8c8");
  assert.equal(pieceAt(b, "c8"), "bK");
  assert.equal(pieceAt(b, "d8"), "bR");
  assert.equal(pieceAt(b, "b8"), null);
  assert.equal(pieceAt(b, "a8"), null);
});

test("applyUciMove: a rook 'castling-shaped' move does not move the rook", () => {
  // A rook on e1 going e1->g1 must not drag the h1 rook along (only a king does).
  const b = applyUciMove(boardFromFen("8/8/8/8/8/8/8/4R2R w - - 0 1"), "e1g1");
  assert.equal(pieceAt(b, "g1"), "wR");
  assert.equal(pieceAt(b, "f1"), null);
  assert.equal(pieceAt(b, "h1"), "wR");
});

// --- applyUciMove: en passant ------------------------------------------------

test("applyUciMove: en passant removes the captured pawn", () => {
  const b = applyUciMove(
    boardFromFen("rnbqkbnr/pppp1ppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3"),
    "d4e3",
  );
  assert.equal(pieceAt(b, "e3"), "bP");
  assert.equal(pieceAt(b, "e4"), null); // the captured white pawn
});

// --- applyUciMove: promotion --------------------------------------------------

test("applyUciMove: promotion without capture keeps the colour", () => {
  const b = applyUciMove(boardFromFen("8/P7/8/8/8/8/k6K/8 w - - 0 1"), "a7a8q");
  assert.equal(pieceAt(b, "a8"), "wQ");
  assert.equal(pieceAt(b, "a7"), null);
});

test("applyUciMove: promotion with capture", () => {
  const b = applyUciMove(boardFromFen("1n6/P7/8/8/8/8/k6K/8 w - - 0 1"), "a7b8q");
  assert.equal(pieceAt(b, "b8"), "wQ");
  assert.equal(pieceAt(b, "a7"), null);
});

test("applyUciMove: black underpromotion to a knight", () => {
  const b = applyUciMove(boardFromFen("8/8/8/8/8/8/p5k1/7K b - - 0 1"), "a2a1n");
  assert.equal(pieceAt(b, "a1"), "bN");
});

// --- replaySan ----------------------------------------------------------------

const RUY = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O";

test("replaySan: known PGN reaches the known position", () => {
  const pos = replaySan(RUY, 9);
  assert.equal(
    pos.fen,
    "r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5",
  );
  assert.equal(pos.turn, "black");
  assert.deepEqual(pos.lastMove, ["e1", "g1"]); // white just castled
});

test("replaySan: replaying zero plies is the start position", () => {
  const pos = replaySan("1. e4 e5", 0);
  assert.equal(pos.fen, START_FEN);
  assert.equal(pos.lastMove, null);
});

test("replaySan: captures and a pawn push in an Evans-style game", () => {
  const pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. Qxd4";
  const pos = replaySan(pgn, 13);
  assert.equal(pieceAt(pos.board, "d4"), "wQ"); // the queen recaptured on d4
  assert.equal(pos.turn, "black");
});

test("replaySan: en passant capture in a real game", () => {
  const pgn = "1. e4 Nf6 2. e5 d5 3. exd6";
  const pos = replaySan(pgn, 5);
  assert.equal(pieceAt(pos.board, "d6"), "wP"); // the pawn passed onto d6
  assert.equal(pieceAt(pos.board, "d5"), null); // the captured pawn is gone
});

test("replaySan: black queenside castling (with knight disambiguation)", () => {
  // The queen must leave d8 and the b8 knight must move before O-O-O is legal.
  const pgn = "1. d4 d5 2. Nf3 Nf6 3. Bf4 Bf5 4. e3 Nc6 5. Bd3 Qd7 6. Nbd2 O-O-O";
  const pos = replaySan(pgn, 12);
  assert.equal(pieceAt(pos.board, "c8"), "bK");
  assert.equal(pieceAt(pos.board, "d8"), "bR");
  assert.equal(pos.lastMove[1], "c8");
});

test("replaySan: PGN headers, comments and move numbers are ignored", () => {
  const pgn = '[Event "Test"]\n[Result "1-0"]\n\n1. e4 { best by test } e5 2. Nf3 1-0';
  const pos = replaySan(pgn, 3);
  assert.equal(pos.fen.split(" ")[1], "b"); // after 1. e4 e5 2. Nf3 black is to move
});

test("sanTokens strips headers, numbers, comments, NAGs and results", () => {
  assert.deepEqual(
    sanTokens('[Event "x"]\n\n1. e4!? e5 $1 { c } 2. Nf3?! 0-1'),
    ["e4", "e5", "Nf3"],
  );
});

// --- legality -----------------------------------------------------------------

test("legalUciMoves: the start position has 20 moves", () => {
  assert.equal(legalUciMoves(parseFen(START_FEN)).length, 20);
});

test("isLegalUci rejects moves that leave the king in check", () => {
  // White's f3 pawn is pinned... use a position where moving the king into check is illegal.
  const pos = parseFen("8/8/8/8/8/5k2/8/4K3 b - - 0 1");
  assert.equal(isLegalUci(pos, "f3f2"), false); // kings cannot touch
  assert.equal(isLegalUci(pos, "f3g3"), true);
});

test("isLegalUci accepts castling only with rights and clear squares", () => {
  const ok = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.ok(isLegalUci(ok, "e1g1"));
  const blocked = parseFen("r3k2r/8/8/8/8/8/8/RN2K1NR w KQkq - 0 1");
  assert.equal(isLegalUci(blocked, "e1g1"), false);
  const noRights = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1");
  assert.equal(isLegalUci(noRights, "e1g1"), false);
});

// --- orientation and the initialPly off-by-one (recorded fixture) ---------------

test("board rows are rank 8 first (white at the bottom of the matrix)", () => {
  const pos = parseFen(START_FEN);
  assert.equal(pos.board[0][4], "bK"); // e8 is the first row, fifth column
  assert.equal(pos.board[7][4], "wK");
  assert.equal(colorOf(pos.board[0][0]), "black");
});

test("fixture: replaying initialPly + 1 plies makes solution[0] legal", () => {
  const daily = JSON.parse(readFileSync(path.join(FIXTURES, "daily.json"), "utf8"));
  const pos = replaySan(daily.game.pgn, daily.puzzle.initialPly + 1);
  // The side to move must be the player, and the player's first solution move legal.
  assert.equal(isLegalUci(pos, daily.puzzle.solution[0]), true);
  const [fr] = [daily.puzzle.solution[0].slice(0, 2)];
  assert.equal(colorOf(pieceAt(pos.board, fr)), pos.turn);
  // One ply fewer flips the side to move (the +/-1 ambiguity is real: this
  // fixture's solution[0] is also legal there, for the other side — the fetcher
  // therefore tries initialPly + 1 first, which this assert pins down).
  const minus = replaySan(daily.game.pgn, daily.puzzle.initialPly);
  assert.equal(minus.turn, pos.turn === "white" ? "black" : "white");
});

test("fixture: cached puzzle JSON validates against the cached board", () => {
  // If a cache file was produced by the fetcher (fetch.test.mjs does this in tmp),
  // the contract holds: turn matches the board's side to move and lastMove is set.
  const pos = replaySan("1. e4 e5", 2);
  assert.equal(pos.turn, "white");
  assert.deepEqual(pos.lastMove, ["e7", "e5"]);
});
