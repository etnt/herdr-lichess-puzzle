// Pure chess logic shared by the fetcher (Node) and the UI (Herdr's GPUI runtime).
// No Herdr imports here: this file must load in both runtimes.
//
// Board shape (the mod's data contract): board[0] is rank 8 (a8..h8), board[7] is
// rank 1. A square holds "wP", "bK", ... (colour letter + piece letter, uppercase)
// or null. Square names are the usual "e4" style.

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FILES = "abcdefgh";
const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ROOK_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

/** Row/col (board indexes) -> square name. `squareName(0, 4)` is "e8". */
export function squareName(r, c) {
  return FILES[c] + String(8 - r);
}

/** Square name -> [row, col]. `squareRC("e8")` is [0, 4]. */
export function squareRC(name) {
  return [8 - Number(name[1]), FILES.indexOf(name[0])];
}

/** "wP" -> "white", "bK" -> "black". */
export function colorOf(piece) {
  return piece[0] === "w" ? "white" : "black";
}

/** The piece on a square, or null. */
export function pieceAt(board, name) {
  const [r, c] = squareRC(name);
  return board[r]?.[c] ?? null;
}

/** Parses a FEN into { board, turn, castling, ep, halfmove, fullmove }. */
export function parseFen(fen) {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new Error("bad FEN: " + fen);
  const [placement, turn, castling, ep, halfmove, fullmove] = parts;
  const rows = placement.split("/");
  if (rows.length !== 8) throw new Error("bad FEN placement: " + fen);
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= "1" && ch <= "8") c += Number(ch);
      else {
        if (c > 7 || !"KQRBNPkqrbnp".includes(ch)) throw new Error("bad FEN rank: " + rows[r]);
        board[r][c++] = ch === ch.toUpperCase() ? "w" + ch.toUpperCase() : "b" + ch.toUpperCase();
      }
    }
    if (c !== 8) throw new Error("bad FEN rank: " + rows[r]);
  }
  return {
    board,
    turn: turn === "b" ? "black" : "white",
    castling: castling === "-" ? "" : castling,
    ep: ep && ep !== "-" ? ep : null,
    halfmove: Number(halfmove ?? 0) || 0,
    fullmove: Number(fullmove ?? 1) || 1,
  };
}

/** The 8x8 board matrix of a FEN. */
export function boardFromFen(fen) {
  return parseFen(fen).board;
}

// --- attack detection -------------------------------------------------------

function isAttacked(board, r, c, by) {
  const mine = by === "white" ? "w" : "b";
  // Pawns: a white pawn one rank below (board-wise) attacks upward.
  const pr = by === "white" ? r + 1 : r - 1;
  for (const dc of [-1, 1]) {
    const cc = c + dc;
    if (pr >= 0 && pr < 8 && cc >= 0 && cc < 8 && board[pr][cc] === mine + "P") return true;
  }
  for (const [dr, dc] of KNIGHT_D) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr][cc] === mine + "N") return true;
  }
  for (const [dr, dc] of KING_D) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr][cc] === mine + "K") return true;
  }
  for (const [dr, dc] of ROOK_D) {
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = board[rr][cc];
      if (p) { if (p === mine + "R" || p === mine + "Q") return true; break; }
      rr += dr; cc += dc;
    }
  }
  for (const [dr, dc] of BISHOP_D) {
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = board[rr][cc];
      if (p) { if (p === mine + "B" || p === mine + "Q") return true; break; }
      rr += dr; cc += dc;
    }
  }
  return false;
}

// --- move generation --------------------------------------------------------

/** Pseudo-legal moves (castling also checks the transit squares and check).
 *  Each move: { from:[r,c], to:[r,c], fromName, toName, piece, uci, promo?, ep?, castle? }. */
function genPseudo(pos) {
  const { board, turn } = pos;
  const white = turn === "white";
  const mine = white ? "w" : "b";
  const theirs = white ? "b" : "w";
  const moves = [];
  const push = (from, to, extra) => {
    const piece = board[from[0]][from[1]];
    moves.push({
      from, to,
      fromName: squareName(from[0], from[1]),
      toName: squareName(to[0], to[1]),
      piece,
      uci: squareName(from[0], from[1]) + squareName(to[0], to[1]),
      ...extra,
    });
  };
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece[0] !== mine) continue;
      const type = piece[1];
      if (type === "P") {
        const dir = white ? -1 : 1;
        const startR = white ? 6 : 1;
        const promoR = white ? 0 : 7;
        const tr = r + dir;
        if (tr >= 0 && tr < 8 && !board[tr][c]) {
          if (tr === promoR) for (const p of ["q", "r", "b", "n"]) push([r, c], [tr, c], { promo: p });
          else {
            push([r, c], [tr, c]);
            const jr = r + 2 * dir;
            if (r === startR && !board[jr][c]) push([r, c], [jr, c]);
          }
        }
        for (const dc of [-1, 1]) {
          const tc = c + dc;
          if (tr < 0 || tr > 7 || tc < 0 || tc > 7) continue;
          const target = board[tr][tc];
          if (target && target[0] === theirs) {
            if (tr === promoR) for (const p of ["q", "r", "b", "n"]) push([r, c], [tr, tc], { promo: p });
            else push([r, c], [tr, tc]);
          } else if (!target && pos.ep === squareName(tr, tc)) {
            push([r, c], [tr, tc], { ep: true });
          }
        }
      } else if (type === "N" || type === "K") {
        for (const [dr, dc] of (type === "N" ? KNIGHT_D : KING_D)) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          if (!board[rr][cc] || board[rr][cc][0] === theirs) push([r, c], [rr, cc]);
        }
        if (type === "K") genCastles(pos, r, c, mine, theirs, push);
      } else {
        const dirs = type === "R" ? ROOK_D : type === "B" ? BISHOP_D : [...ROOK_D, ...BISHOP_D];
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
            const target = board[rr][cc];
            if (!target) push([r, c], [rr, cc]);
            else { if (target[0] === theirs) push([r, c], [rr, cc]); break; }
            rr += dr; cc += dc;
          }
        }
      }
    }
  }
  return moves;
}

function genCastles(pos, r, c, mine, theirs, push) {
  // Only from the king's home square, with the right and rook present, the path
  // empty, and the king not in check nor crossing an attacked square.
  const home = mine === "w" ? 7 : 0;
  if (r !== home || c !== 4) return;
  const enemy = theirs === "w" ? "white" : "black";
  const rights = pos.castling;
  const K = mine === "w" ? "K" : "k", Q = mine === "w" ? "Q" : "q";
  if (rights.includes(K) && pos.board[home][7] === mine + "R"
    && !pos.board[home][5] && !pos.board[home][6]
    && !isAttacked(pos.board, home, 4, enemy) && !isAttacked(pos.board, home, 5, enemy)) {
    push([home, 4], [home, 6], { castle: "K" });
  }
  if (rights.includes(Q) && pos.board[home][0] === mine + "R"
    && !pos.board[home][1] && !pos.board[home][2] && !pos.board[home][3]
    && !isAttacked(pos.board, home, 4, enemy) && !isAttacked(pos.board, home, 3, enemy)) {
    push([home, 4], [home, 2], { castle: "Q" });
  }
}

/** Applies a move object to a position; returns a new position (no mutation). */
function makeMove(pos, mv) {
  const b = pos.board.map((row) => row.slice());
  const [fr, fc] = mv.from, [tr, tc] = mv.to;
  const piece = b[fr][fc];
  const captured = mv.ep || Boolean(b[tr][tc]);
  b[fr][fc] = null;
  if (mv.ep) b[fr][tc] = null;
  b[tr][tc] = mv.promo ? piece[0] + mv.promo.toUpperCase() : piece;
  if (mv.castle === "K") { b[tr][5] = b[tr][7]; b[tr][7] = null; }
  if (mv.castle === "Q") { b[tr][3] = b[tr][0]; b[tr][0] = null; }
  let castling = pos.castling;
  const strip = (chars) => { for (const ch of chars) castling = castling.replace(ch, ""); };
  if (piece[1] === "K") strip(piece[0] === "w" ? "KQ" : "kq");
  if (piece[1] === "R") {
    if (fr === 7 && fc === 0) strip("Q");
    if (fr === 7 && fc === 7) strip("K");
    if (fr === 0 && fc === 0) strip("q");
    if (fr === 0 && fc === 7) strip("k");
  }
  if (tr === 7 && tc === 0) strip("Q");
  if (tr === 7 && tc === 7) strip("K");
  if (tr === 0 && tc === 0) strip("q");
  if (tr === 0 && tc === 7) strip("k");
  const white = piece[0] === "w";
  return {
    board: b,
    turn: white ? "black" : "white",
    castling,
    ep: piece[1] === "P" && Math.abs(tr - fr) === 2 ? squareName((fr + tr) / 2, fc) : null,
    halfmove: piece[1] === "P" || captured ? 0 : pos.halfmove + 1,
    fullmove: white ? pos.fullmove : pos.fullmove + 1,
  };
}

/** Legal moves of a position (pseudo-legal filtered by own-king safety).
 *  Accepts a parseFen/replaySan-shaped position. Returns move objects. */
export function legalMoves(pos) {
  return genPseudo(pos).filter((mv) => {
    const next = makeMove(pos, mv);
    const mine = pos.turn === "white" ? "w" : "b";
    let kr = -1, kc = -1, found = false;
    for (let r = 0; r < 8 && !found; r++)
      for (let c = 0; c < 8; c++)
        if (next.board[r][c] === mine + "K") { kr = r; kc = c; found = true; break; }
    if (!found) return true; // no king on the board: nothing to defend
    return !isAttacked(next.board, kr, kc, pos.turn === "white" ? "black" : "white");
  });
}

/** Legal moves of a position as UCI strings ("e2e4", "e7e8q"). */
export function legalUciMoves(pos) {
  return legalMoves(pos).map((mv) => mv.uci);
}

/** True when `uci` is a legal move in `pos`. */
export function isLegalUci(pos, uci) {
  return legalUciMoves(pos).includes(uci);
}

// --- SAN replay -------------------------------------------------------------

/** Strips a PGN down to its SAN move tokens. */
export function sanTokens(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, " ")
    .replace(/;[^\n]*/g, " ")
    .replace(/^\s*\[[^\]]*\]\s*$/gm, " ")
    .replace(/\$\d+/g, " ")
    .replace(/\d+\.(?:\.\.)?/g, " ")
    .replace(/(^|\s)(1-0|0-1|1\/2-1\/2|\*)(?=\s|$)/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[!?]+$/, "")) // annotation suffixes: e4!? Nf3?!
    .filter(Boolean);
}

function startFenOf(pgn) {
  const m = /\[FEN\s+"([^"]+)"\]/.exec(pgn);
  return m ? m[1] : START_FEN;
}

function sanToMove(pos, san) {
  const clean = san.replace(/[+#?!]+$/, "");
  const legal = legalMoves(pos);
  if (/^(O-O-O|0-0-0)$/.test(clean))
    return one(legal.filter((mv) => mv.castle === "Q"), san);
  if (/^(O-O|0-0)$/.test(clean))
    return one(legal.filter((mv) => mv.castle === "K"), san);
  const m = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=?([QRBN]))?$/.exec(clean);
  if (!m) throw new Error("cannot parse SAN: " + san);
  const [, pieceCh, ff, frk, , dest, promo] = m;
  return one(legal.filter((mv) =>
    mv.piece[1] === (pieceCh ?? "P")
    && mv.toName === dest
    && (!ff || FILES[mv.from[1]] === ff)
    && (!frk || 8 - mv.from[0] === Number(frk))
    && (!promo || (mv.promo ?? "").toUpperCase() === promo)
  ), san);
}

function one(candidates, san) {
  if (candidates.length === 1) return candidates[0];
  throw new Error(`SAN "${san}" matches ${candidates.length} legal moves`);
}

/** Replays the first `plies` SAN half-moves of a PGN.
 *  Returns { board, turn, castling, ep, lastMove, fen } — a position shaped like
 *  parseFen's result, plus the last move as [from, to] (null if no moves played). */
export function replaySan(pgn, plies) {
  const tokens = sanTokens(pgn);
  let pos = parseFen(startFenOf(pgn));
  let last = null;
  const n = Math.min(plies, tokens.length);
  for (let i = 0; i < n; i++) {
    const mv = sanToMove(pos, tokens[i]);
    pos = makeMove(pos, mv);
    last = [mv.fromName, mv.toName];
  }
  return { board: pos.board, turn: pos.turn, castling: pos.castling, ep: pos.ep, lastMove: last, fen: fenOf(pos) };
}

function fenOf(pos) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = "", empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r][c];
      if (!p) empty++;
      else {
        if (empty) { row += empty; empty = 0; }
        row += p[0] === "w" ? p[1] : p[1].toLowerCase();
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join("/")} ${pos.turn === "white" ? "w" : "b"} ${pos.castling || "-"} ${pos.ep || "-"} ${pos.halfmove} ${pos.fullmove}`;
}

// --- UI-side move application ----------------------------------------------

/** Applies a UCI move to a plain board matrix (no legality check — the caller
 *  validates against the puzzle solution). Handles castling (the moving piece
 *  must be a king), en passant and promotion. Returns a new board. */
export function applyUciMove(board, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(uci)) throw new Error("bad UCI move: " + uci);
  const b = board.map((row) => row.slice());
  const [fr, fc] = squareRC(uci.slice(0, 2));
  const [tr, tc] = squareRC(uci.slice(2, 4));
  const piece = b[fr][fc];
  if (!piece) throw new Error(`no piece on ${uci.slice(0, 2)}`);
  b[fr][fc] = null;
  // En passant: a pawn moving diagonally onto an empty square captures the pawn
  // on the origin rank, in the target file.
  if (piece[1] === "P" && fc !== tc && !b[tr][tc]) b[fr][tc] = null;
  // Castling: a king moving two files also moves the rook.
  if (piece[1] === "K" && Math.abs(tc - fc) === 2) {
    if (tc === 6) { b[tr][5] = b[tr][7]; b[tr][7] = null; }
    else { b[tr][3] = b[tr][0]; b[tr][0] = null; }
  }
  b[tr][tc] = uci.length > 4 ? piece[0] + uci[4].toUpperCase() : piece;
  return b;
}
