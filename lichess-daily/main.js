// Lichess Daily — a daily chess puzzle in a Herdr pane.
//
// A fetcher (`fetch_puzzle.mjs`, plain Node) writes cache/YYYY-MM-DD.json next to
// this file; the UI here reads that cache and renders an interactive board. The
// chess logic is shared with the fetcher in ./chess.js (pure, no Herdr imports).
//
// Flow in init(): skip all side effects while `checking()` (herdr-app check);
// otherwise run the fetcher (it exits immediately on a cache hit), read today's
// cache file, and fall back to the newest cached day when offline with no file
// for today. Dates are UTC, matching Lichess's daily rollover, and identical to
// the fetcher's rule.
//
// Playing: click your piece, then the target square. A move is accepted when it
// matches `solution[stepIndex]` (a promotion defaults to the solution's piece).
// After your move the opponent's reply is played 300 ms later (cx.timer, never
// setTimeout); clicks are ignored while it is pending. Alternate mating moves
// are rejected in v1 — the help text in the footer says so.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, exec, readTextFile, theme } from "herdr";
import { applyUciMove, colorOf, pieceAt } from "./chess.js";

const MOD_DIR = () => `${appHome()}/mods/lichess-daily`;

/** Today's date, UTC, as YYYY-MM-DD — the same rule the fetcher uses. */
function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function lum(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

export default class LichessDaily extends View {
  init(_props, cx) {
    this.status = "loading"; // loading | playing | wrong | solved | error
    this.error = null;
    this.day = null;
    this.size = null; // { width, height }, from on_size_change
    this.replyPending = false;
    this.checking = checking();
    this.load(cx);
    // Day rollover: a cheap string compare every minute; the reload only happens
    // when the UTC date has actually changed.
    cx.timer.every(60_000, (cx) => {
      if (this.day && utcToday() !== this.day && !this.checking) this.load(cx);
    });
  }

  async load(cx) {
    this.day = utcToday();
    const dir = MOD_DIR();
    // The fetcher is a side effect: never run it during `herdr-app check`.
    if (!checking()) {
      try {
        await this.runNode([`${dir}/fetch_puzzle.mjs`], dir);
      } catch (err) {
        this.fetchError = String(err?.message ?? err);
      }
    }
    let text = await readTextFile(`${dir}/cache/${this.day}.json`);
    if (text == null) {
      // Offline with no cache for today: fall back to the newest cached day.
      const newest = await this.newestCache(dir);
      if (newest) text = await readTextFile(newest);
    }
    if (text == null) {
      this.status = "error";
      this.error = this.fetchError
        ? "No cached puzzle and the fetch failed. Check your connection and reopen this pane."
        : "No cached puzzle yet. Check your connection and reopen this pane.";
      cx.notify();
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      this.status = "error";
      this.error = "The puzzle cache is corrupt. Delete cache/*.json and reopen.";
      cx.notify();
      return;
    }
    this.setupPuzzle(data);
    cx.notify();
  }

  // `node` first (the user's real PATH via exec), then common fallbacks.
  async runNode(args, cwd) {
    let lastErr;
    for (const bin of ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
      try {
        const r = await exec(bin, args, { cwd, timeout: 20_000 });
        if (r.code === 0) return r;
        lastErr = new Error(r.stderr?.trim() || `exit ${r.code}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async newestCache(dir) {
    if (checking()) return null;
    try {
      const r = await exec("sh", ["-c", `ls -t "${dir}"/cache/*.json 2>/dev/null | head -1`], { timeout: 5000 });
      const line = r.stdout.trim().split("\n")[0];
      return line || null;
    } catch {
      return null;
    }
  }

  setupPuzzle(data) {
    this.data = data;
    this.day = data.date;
    this.board = data.board.map((row) => row.slice());
    this.stepIndex = 0;
    this.selected = null;
    this.lastMove = data.lastMove ?? null;
    this.hint = null;
    this.wrongSquare = null;
    this.replyPending = false;
    this.flipped = data.turn === "black";
    this.player = data.turn; // "white" | "black": the side the player controls
    this.status = "playing";
  }

  reset(cx) {
    if (this.data) this.setupPuzzle(this.data);
    cx.notify();
  }

  hintNow(cx) {
    if (this.status !== "playing" || this.stepIndex >= (this.data?.solution.length ?? 0)) return;
    this.hint = this.data.solution[this.stepIndex].slice(0, 2);
    cx.notify();
    cx.timer.after(2000, (cx) => {
      if (this.hint) { this.hint = null; cx.notify(); }
    });
  }

  onSquare(name, cx) {
    // Ignore clicks while loading, solved, in error, or while the opponent's
    // reply is pending.
    if (this.replyPending) return;
    if (this.status !== "playing" && this.status !== "wrong") return;
    const piece = pieceAt(this.board, name);
    const mine = this.player === "white" ? "w" : "b";

    if (piece && piece[0] === mine) {
      // Clicking one of your own pieces selects it (or re-selects).
      this.selected = this.selected === name ? null : name;
      this.status = "playing";
      cx.notify();
      return;
    }
    if (!this.selected) return;

    const sol = this.data.solution[this.stepIndex];
    const cand = this.selected + name; // e.g. "g6g7"; a promotion defaults to the solution's piece
    if (sol.startsWith(cand)) {
      this.board = applyUciMove(this.board, sol);
      this.lastMove = [cand.slice(0, 2), cand.slice(2)];
      this.stepIndex++;
      this.selected = null;
      this.hint = null;
      if (this.stepIndex >= this.data.solution.length) {
        this.status = "solved";
      } else {
        this.replyPending = true;
        cx.timer.after(300, (cx) => {
          this.replyPending = false;
          const reply = this.data.solution[this.stepIndex];
          this.board = applyUciMove(this.board, reply);
          this.lastMove = [reply.slice(0, 2), reply.slice(2)];
          this.stepIndex++;
          if (this.stepIndex >= this.data.solution.length) this.status = "solved";
          cx.notify();
        });
      }
    } else {
      this.status = "wrong";
      this.wrongSquare = name;
      cx.timer.after(900, (cx) => {
        if (this.status === "wrong") { this.status = "playing"; this.wrongSquare = null; cx.notify(); }
      });
    }
    cx.notify();
  }

  // --- rendering ---

  squarePx() {
    const w = this.size?.width ?? 400;
    return Math.max(24, Math.floor((Math.min(w, 520) - 16) / 8));
  }

  squareColors(t) {
    // Theme-aware board tones: pick a palette by the background's luminance so
    // both the light and dark themes get usable contrast for the glyphs.
    if (lum(t.background) < 128) return { light: "#98a2ac", dark: "#5c6670" };
    return { light: "#eef1ee", dark: "#7c96ab" };
  }

  glyph(piece) {
    // Filled glyphs for black, outline glyphs for white — both fonts render the
    // filled shapes strongly, but a filled white glyph would vanish on a light square.
    const G = piece[0] === "w"
      ? { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙" }
      : { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };
    return G[piece[1]];
  }

  pieceColor(piece) {
    return piece[0] === "w" ? "#f7f7f2" : "#191919";
  }

  header(t) {
    const badge = (text, color) => div().flex_none().px(7).h(20).flex().items_center().rounded(5)
      .bg(color + "26").text_size(10.5).font_semibold().text_color(color).child(text);
    const st = this.status;
    return h_flex().flex_none().items_center().gap(8)
      .child(div().flex_1().truncate().font_semibold().text_size(13).text_color(t.foreground).child("Lichess Daily"))
      .when(this.data, (el) => el
        .child(badge(`${this.data.rating ?? "?"}`, t.dim))
        .child(div().text_size(11).text_color(t.dim)
          .child(this.flipped ? "Black to move" : "White to move")))
      .when(st === "loading", (el) => el.child(badge("Loading…", t.dim)))
      .when(st === "wrong", (el) => el.child(badge("Try again", t.blocked)))
      .when(st === "solved", (el) => el.child(badge("Solved!", t.done)))
      .when(st === "error", (el) => el.child(badge("Error", t.blocked)));
  }

  boardView(t, px) {
    const sq = this.squareColors(t);
    const hl = {
      last: "#e6c34a55",
      selected: (t.accent ?? "#5b8def") + "77",
      hint: (t.done ?? "#46a758") + "77",
      wrong: (t.blocked ?? "#e5484d") + "77",
    };
    const rows = [];
    for (let di = 0; di < 8; di++) {
      const cells = [];
      for (let dj = 0; dj < 8; dj++) {
        const r = this.flipped ? 7 - di : di;
        const c = this.flipped ? 7 - dj : dj;
        const name = "abcdefgh"[c] + String(8 - r);
        const piece = this.board[r][c];
        let bg = (r + c) % 2 === 0 ? sq.dark : sq.light;
        if (this.wrongSquare === name) bg = hl.wrong;
        else if (this.hint === name) bg = hl.hint;
        else if (this.selected === name) bg = hl.selected;
        else if (this.lastMove?.includes(name)) bg = hl.last;
        cells.push(
          div()
            .id(`sq-${name}`)
            .w(px).h(px).flex_none().flex().items_center().justify_center()
            .bg(bg).cursor_pointer()
            .on_click((_e, cx) => this.onSquare(name, cx))
            .when(Boolean(piece), (el) => el.child(
              div().text_size(px * 0.72).text_color(this.pieceColor(piece)).child(this.glyph(piece)),
            )),
        );
      }
      rows.push(h_flex().flex_none().children(cells));
    }
    return v_flex().flex_none().border_1().border_color(t.border).rounded(4).overflow_hidden().children(rows);
  }

  // Buttons hand their click's own cx to the action — never the render-time one.
  footButton(t, id, label, action) {
    return h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(6)
      .bg(t.raised).text_size(11).font_medium().text_color(t.foreground).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
  }

  footer(t, cx) {
    return v_flex().flex_none().gap(6)
      .child(h_flex().gap(6).flex_wrap()
        .child(this.footButton(t, "btn-hint", "Hint", (c) => this.hintNow(c)))
        .child(this.footButton(t, "btn-reset", "Reset", (c) => this.reset(c)))
        .when(this.data, (el) => el.child(this.footButton(t, "btn-open", "Open on Lichess", (c) => {
          c.open_url(`https://lichess.org/training/${this.data.id}`);
        }))))
      .child(div().text_size(10.5).text_color(t.dim).child(
        this.status === "solved"
          ? "Solved — nice. A new puzzle arrives at UTC midnight."
          : "Click your piece, then the target square. Hint shows the piece to move. Alternate mating moves are not accepted in this version — play the listed solution.",
      ));
  }

  errorView(cx) {
    const t = theme();
    return v_flex().flex_1().items_center().justify_center().gap(6).p(12)
      .child(div().text_size(12).text_color(t.blocked).child(this.error ?? "Something went wrong."))
      .child(this.footButton(t, "btn-retry", "Retry", (c) => { this.status = "loading"; this.load(c); }));
  }

  render(cx) {
    const t = theme();
    const px = this.squarePx();
    const body = this.status === "error"
      ? this.errorView(cx)
      : this.status === "loading" && !this.data
        ? v_flex().flex_1().items_center().justify_center()
          .child(div().text_size(12).text_color(t.dim).child("Loading today's puzzle…"))
        : v_flex().flex_1().items_center().justify_center().gap(8)
          .child(this.boardView(t, px))
          .child(this.footer(t, cx));
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.background)
      .p(8)
      .gap(8)
      .text_size(12)
      .on_size_change((size, c) => {
        const w = Math.floor((Math.min(size.width, 520) - 16) / 8);
        if (!this.size || w !== Math.floor((this.size.width - 16) / 8)) { this.size = size; c.notify(); }
      })
      .child(this.header(t))
      .child(body);
  }
}
