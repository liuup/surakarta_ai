# Surakarta

Surakarta, a traditional Indonesian board game, played against an AI with four
adjustable search depths. There are two front ends — **web** and **terminal** —
sharing a single backend service, so both show the same game. The interface is
available in **English and Chinese**, English by default.
No third-party libraries, build tools, or npm packages.

**English** | [中文](README.zh-CN.md)

## Running it

```bash
node server.js                 # start the backend, default http://127.0.0.1:8123
```

- **Web**: open <http://127.0.0.1:8123/> in a browser
- **Terminal**: in another terminal, run `node tui.js`

Both can be open at once and share the same game: play a move in the terminal and
the page catches up a moment later, and the other way round.

You do not need the server either: open `index.html` directly in a browser, and
when the page cannot find a backend it falls back to playing the game inside the
page, with exactly the same features. Add `?local=1` to the URL to force that
offline mode.

```bash
node server.js --port 9000     # different port
node server.js --lang zh       # server messages in Chinese (English by default)
node tui.js --server http://127.0.0.1:9000
```

## Layout

```
server.js           Backend: static files + JSON API + driving the AI search
tui.js              Terminal interface (draws and reads keys; all logic is on the backend)
index.html          Page structure and the rules text
css/style.css       Page styles
js/rules.js         Rules engine (board geometry, move generation, path tracing)
js/ai.js            AI search (alpha-beta + transposition table + capture quiescence)
js/session.js       One game's state machine (moves/undo/end/AI scheduling), shared by Node and the browser
js/i18n.js          The English and Chinese text tables (the only place UI text lives)
js/main.js          Web interface: draws the board and handles the mouse; all state comes from a "driver"
tests/              Tests, see below
```

### Three layers

```
        js/rules.js   js/ai.js          ← rules and search, pure functions, no UI
              │
        js/session.js                  ← one game: state, history, end conditions, AI scheduling
              │
      ┌───────┴────────┐
   server.js         main.js in the browser
      │                 (offline mode runs session.js directly)
   ┌──┴───┐
  web    tui.js                        each front end renders text via js/i18n.js
```

`js/session.js` touches no DOM and sets no timers of its own; whoever calls it
drives the AI search forward. That is why the same game logic can run inside the
service (shared by the web page and the terminal) and inside the page (offline).
Online, the page only draws the result of `GET /api/state` and makes no rules
decisions of its own.

### Text and game logic are separate

`js/session.js` **produces no user-facing text at all**, only structured data:
a move is `{side, from, to, capture}`, an ending is `{kind, winner, side, counts}`,
an error is `{code, params}`. Language lives only in one flat key/value table in
`js/i18n.js`, and each front end looks up what it needs.

The direct benefit of that split: **the same game can be shown in Chinese on the
web page and in English in the terminal.** Switching language needs no new game
and no fresh data from the backend — `state.moves` and `state.result` are
untouched, only the wording changes. The `message` field the server returns is
readable text for `curl` and logs, generated according to `--lang`; no front end
uses it.

Only two things inside the engine are language-related, and both come from that
same table: intersection names (`a1`…`f6`, identical in both languages) and the
display names of the four difficulty levels (`i18n.level.{key}`).

## The rules implemented

Everything below follows the traditional rules exactly, with nothing added or
removed:

- The board is a 6×6 grid of intersections, 36 points in all. Each side has 12
  pieces, starting on the two rows nearest that player, with the two middle rows
  empty.
- A quiet move takes one piece to an adjacent empty point, horizontally,
  vertically, or diagonally. No jumping, and no landing on an occupied point.
- A capture travels in a straight line along the piece's row or column, and every
  intersection it passes over must be empty. When it reaches the end of that line,
  if a corner loop is there, it leaves the board tangentially, rides the
  three-quarter arc outside the board, and comes back in along the adjacent line,
  continuing its journey. The direction only ever turns 90°, and only while riding
  a loop.
- Only after riding **at least one** corner loop may the piece land on the first
  enemy piece it meets and capture it. Meeting a friendly piece, or meeting any
  piece before riding a loop, means no capture in that direction.
- The same empty point may be passed more than once during a capture (for example
  riding a loop and then passing back over its own starting point, which is now
  empty).
- Capturing is never compulsory and may be declined.
- Corner loops are used for captures only; a quiet move never rides one — the
  standard rules do not allow "sliding around a loop without capturing" (that is
  a variant).
- Rows 0 and 5 and columns 0 and 5 — the four outermost lines — have no loops, so
  a piece cannot ride a loop along them. At the four corners (0,0), (0,5), (5,0),
  (5,5) both of the piece's lines are loopless, so **a piece in a corner can never
  capture**. The other intersections on the outermost ring can still capture, as
  long as they travel along the line in the other direction that does carry a
  loop — those points are exactly where an arc meets the edge of the board.
- Capturing all 12 enemy pieces wins.

### The geometry of the corner loops

Each of the four corners has two concentric circles, of radius 1 and 2 squares:

- The radius-1 circle is tangent to the board lines at the points "second in from
  the corner"; four such arcs form the **inner circuit**, passing through rows 1
  and 4 and columns 1 and 4.
- The radius-2 circle is tangent at the points "third in from the corner"; four
  such arcs form the **outer circuit**, passing through rows 2 and 3 and columns 2
  and 3.

That makes eight corner loops in all. The quarter of each arc that falls inside
the board coincides with a board line; the three-quarters outside the board are
what actually forms the loop. The two circuits meet only at intersections, and a
capture path cannot change lines there.

### Verifying the rules

Sources: the Wikipedia article "Surakarta (game)", the Masters of Games rules
page, Cyningstan's one-page rules sheet, Tabletopia's official rules, and
igGameCenter. They agree completely on the board, the opening setup, how pieces
move, the loop geometry, how captures work, and how a game is won. The key
clauses:

| Clause | Source wording |
| --- | --- |
| 12 pieces each, 6×6 | Wikipedia: "Players begin the game with 12 pieces each." |
| Diagonal moves are legal | Wikipedia: "moves one of their pieces a single step in any direction (forwards, backwards, sideways, or diagonally) to an unoccupied point"; Cyningstan: "horizontally, vertically or diagonally" |
| Eight corner loops, centred on the corners, radii 1 and 2 | Masters of Games: "The points second in at each corner are connected by a three-quarter circle and the points third in from each corner are connected by a larger three-quarter circle concentrically outside the first." |
| Enter and leave tangentially, turning 90° | Wikipedia: "The capturing piece enters and leaves the circular loop via a grid line tangent to the circle." |
| At least one loop must be ridden | Wikipedia: "around at least one of the eight corner loops"; Masters of Games: "At least one loop MUST be travelled around in order to capture." |
| Only empty points, no jumping | Wikipedia: "Only unoccupied points may be travelled over; jumping over pieces is not permitted." |
| An empty point may be passed more than once | Wikipedia: "An unoccupied point may be travelled over more than once during the capturing piece's journey." |
| Capturing is optional | Wikipedia: "Capturing is always optional (never mandatory)." |
| Corner loops are for captures only | Wikipedia: "Corner loops are used only when making a capture." |
| Capture all 12 to win; when neither side can make headway, agreement decides on material | Wikipedia: "A game is won when a player captures all 12 of the opponent's pieces. If neither side can make headway, the game is ended by agreement and the winner is the player with the greater number of pieces in play." |

Two points worth noting:

- The "variants" section of Wikipedia mentions regional variants that "cannot move
  diagonally and may slide along the outer loop without capturing". Those are
  **variants** and not what the standard rules say; this implementation follows
  the standard rules, where a quiet move is always a single step.
- "Ended by agreement when neither side can make headway" leaves the decision to
  the players. A digital version has to settle on something definite — see
  "Adjudications a digital version has to make" below.

Beyond reading the sources, the geometry itself is cross-checked by two
independent implementations: `js/rules.js` uses a precomputed table of loop
endpoints plus integer stepping, while `tests/geometry.test.js` treats a piece as
a point on the board and works it out again in **floating-point coordinates and
angles** — finding the circle of radius 1 or 2 that is tangent to the exit point
and centred on the corner, riding three-quarters of the way around it, and taking
the new direction from the velocity vector. The two agree point for point over
more than 250,000 piece-and-direction cases and more than 70,000 complete capture
paths. So the geometry in the rules engine is not something written by eye from a
single source.

## What the interface offers

Both front ends offer the same things:

- Selecting one of your pieces marks the empty points it can move to and the enemy
  pieces it can capture.
- **Capture path preview**: pointing at a piece that can be captured draws the
  whole route the piece takes around the corner loops (hover with the mouse on the
  web, move the cursor onto it in the terminal). The route of the most recent
  capture stays on screen as well.
- Board lines are colour-coded by kind: cyan for the inner circuit (rows 1 and 4,
  columns 1 and 4), green for the outer circuit (rows 2 and 3, columns 2 and 3),
  and brown for the outermost lines, which have no loop.
- Four difficulty levels, switchable at any time; a change applies to the AI's
  next move.
- You can play Black (first) or Red (second); changing sides starts a new game
  immediately.
- New game, undo (takes back one move by each side), agree to end.
- Shows the AI's search depth, position evaluation, node count and thinking time,
  plus the move log for both sides.
- **The interface stays responsive while the AI is thinking** — nothing freezes,
  and the progress updates live.

### Language switching

The interface has two languages, **English by default**.

- Web: the two buttons `English / 中文` in the top right switch the whole page at
  once — title, buttons, the rules text, the move log and the end-of-game message;
  `<html lang>` changes too, to `en` or `zh-CN`. The choice is kept in
  `localStorage` and survives a reload.
- Terminal: `--lang zh` at startup, or press `L` at any time to switch back and
  forth. The board itself is not redrawn; only the text around it changes. The `?`
  help sheet lists `L (中文 / English)` as well.

Both languages cover the same 185 strings, with matching keys and matching
placeholders (a test enforces this). A missing string can never render as a blank
either: the lookup falls back to English, then to the same key in the other
language, and only then to the key name itself — so a gap shows up as a foreign
sentence rather than as a blank or a raw `panel.levels`.

### The terminal interface

```bash
node tui.js                        # connects to http://127.0.0.1:8123 by default, English UI
node tui.js --server http://…:9000
node tui.js --lang zh              # Chinese UI
node tui.js --no-color             # no ANSI escapes, Unicode glyphs kept
node tui.js --plain                # plain ASCII, no colour (for logs or terminals that cannot cope)
```

Keys: arrow keys / `hjkl` / `wsd` move the cursor (only `h` goes left, since `a`
is taken by "agree to end"); Enter or Space selects a piece and plays a move onto
a highlight; Esc cancels the selection; `n` new game; `u` undo; `1`–`4` difficulty;
`c` switch sides; `a` agree to end; `L` switch language; `?` help; `q` or Ctrl+C
to quit. The `?` sheet also has a legend explaining every symbol on the board.

The board is drawn with `● ▲ ○ ◦ • ╱ ╲`. In a terminal these are "East Asian
ambiguous width" characters: almost every terminal (Terminal.app, iTerm2, kitty…)
renders them single-width, but if yours treats ambiguous width as double, the board
will be misaligned. Use `--plain` in that case. If the terminal window is too
small, the program says so rather than drawing garbage.

`--plain` does more than swap the board glyphs for ASCII: the `· ● → ’ × ↑↓←→` in
body text are replaced too — they are just as much a source of mojibake on a
terminal that cannot do Unicode — so with the default English UI **the output of
`--plain` is pure ASCII** (a test walks every character). The language row is
written as `L (zh / English)`. A Chinese UI cannot be ASCII, of course:
`--plain --lang zh` gives you an ASCII board with Chinese text around it.

When the output is not a terminal (redirected to a file, or piped) there is no real
size to read, so the layout follows the `COLUMNS` and `LINES` environment
variables, and 80×24 if neither is set. `COLUMNS=40 node tui.js --plain` shows the
narrow-screen stacked layout.

## About the AI

The search engine lives in `js/ai.js` and works like this:

- **Iterative deepening alpha-beta** negamax, with a transposition table (Zobrist
  hashing, 2^18 entries), killer moves, a history heuristic, and captures-first
  move ordering.
- **Capture quiescence**: leaf nodes extend captures only, up to 4 plies, so the
  horizon effect cannot cut a capture chain short.
- **Evaluation**: material (100 per piece) + positional value (a corner is −12,
  being on only one loop-bearing line is 0, being on two is +8) + mobility (4 per
  empty point reachable) + threat difference (30 per piece that can capture right
  now).
- **The search yields in slices**: roughly every 16–20 ms (one frame) it hands
  control back to the event loop and then continues. Yielding by **time** rather
  than by a fixed node count is what keeps machines of different speeds equally
  responsive. That is why searching to depth 8 neither freezes the page nor makes
  the terminal miss keystrokes, HTTP requests are still served, and the progress
  display keeps updating.
- **The lower levels add randomness**: Beginner and Casual pick at random among
  moves whose scores are close to the best, so that no two games are identical;
  Strong and Master always play the move the search found best.
- **No walking back into old positions**: the game tells the search which
  positions have already occurred, and **a move that returns to an old position
  counts as at most a draw** (mate scores are unaffected). This is not declaring a
  repetition a draw — the traditional rules have no such clause, and the game
  itself never ends because of repetition — it just keeps the AI from going round
  in circles when it is ahead. Turning it into "at most a draw" rather than a flat
  penalty is deliberate: repeating is not attractive when you are behind anyway,
  so the AI has no reason to repeat in order to stall.
  Two implementation details matter here. The discount has to be applied to the
  **true search score** (cutting a repeat short into a static evaluation would
  make "repeat" a fixed score, and an optimistic evaluation would then *invite*
  repetition), and it is applied **at the root only**, so that no game history
  leaks into the search tree — that way a score cached in the transposition table
  depends on the position alone and can be reused safely across searches and across
  games. Both have tests.
- **The capture walk's cycle detection must not keep its generation in 32-bit
  integers** (`js/rules.js`; this was a real bug, found by running the thing).
  Deciding "which (intersection, direction) has this walk already covered" uses a
  generation tag: each walk takes the next generation number, writes it into an
  array, and when it later reaches the same intersection heading the same way, an
  equal generation means nothing lies ahead and it can stop. The generation climbs
  monotonically for the life of the process, and the search walks dozens of times
  **per node** — measured at about 79 million walks per second, so **roughly half a
  minute of cumulative thinking pushes it past 2^31**. The array used to be an
  `Int32Array`: the store truncated the number to a negative value while the
  generation it was compared against stayed positive, so `stamp === gen` never
  held again. The guard failed silently and `walkCapture` really did loop forever
  — from the outside, the AI search froze with one core pinned at 100% and the game
  never moved again. It is a `Float64Array` now (exact to 2^53), and that failure
  mode is gone.
  There is a lesson in it worth recording: **short-lived tests cannot catch this.**
  No test process accumulates half a minute of searching, so it never reaches the
  broken range. The test therefore sets the generation straight to the overflow
  point and runs move generation from there (actually running the 2.1 billion walks
  is not something you can put in a test). And so that "someone changes it back to
  `Int32Array`" shows up as a clear failure instead of a hung test suite, that case
  runs in a child process and fails on timeout.

The four levels:

| Level | Search depth | Time limit | Notes |
| --- | --- | --- | --- |
| Beginner | 2 plies | 0.6 s | Random enough to play clearly inferior moves; good for learning the rules |
| Casual | 4 plies | 1.5 s | Sees gains and losses a few moves ahead, occasionally misses one |
| Strong | 6 plies | 4 s | Searches the full 6 plies plus capture extensions |
| Master | 8 plies | 10 s | Strongest; usually finishes depth 8 within a second in the opening, occasionally 7–8 s in a complex middlegame |

Measured search speed is about 1.4–1.6 million nodes per second (Node 24 and
single-threaded Chrome are close on the same machine). If a depth cannot be
finished within the time limit, that depth is abandoned and the last fully
completed depth provides the move, so thinking time always has a ceiling.

## Tests

No test framework needed; run them with `node`:

```bash
node tests/rules.test.js      # 16 rules tests
node tests/geometry.test.js   # 4 corner-loop geometry cross-checks (floating-point vs table-driven)
node tests/session.test.js    # 15 game-session tests (moves/undo/end/AI scheduling)
node tests/ai.test.js         # 11 AI tests
node tests/search.test.js     # 4 search-correctness tests (against naive minimax)
node tests/api.test.js        # 16 backend API tests (starts server.js and makes real HTTP requests)
node tests/i18n.test.js       # 12 text-table tests
node tests/tui.test.js        # 12 terminal-UI tests (starts tui.js for real and feeds it keys)
```

Rules tests cover: loop endpoint pairing, the intersections each circuit passes
through, the number of opening moves, that a loop must be ridden before capturing,
capturing an adjacent enemy after riding one, capturing along the outer circuit,
that a piece in a corner can never capture, the tangency rule (travelling straight
along an outermost column must not turn into a loop beside it), friendly pieces
blocking, that a capture walk passing the same empty point repeatedly still
terminates, that the walk's cycle detection still works once the generation passes
2^31 (see below), path tracing agreeing with the move actually played, left-right
mirror symmetry, and move-generation consistency over 300 random positions (no
duplicates, agreeing with per-piece enumeration, capture targets always enemy
pieces, quiet moves always within the eight neighbours).

The geometry cross-check is described above under "Verifying the rules": the corner
loops are recomputed independently in floating-point coordinates and angles, then
compared point by point with the table-driven implementation in the rules engine
over more than 250,000 cases.

Session tests cover: state surviving a JSON round trip, moves and illegal moves,
captures recording their path, move hints, the AI playing for whichever side is to
move, undo taking back one move by each side, the AI moving first when the human
plays Red, agreeing to end adjudicating on material, the game ending the moment a
side is wiped out, a side with no legal move ending under the agreement rule,
loading a position, switching difficulty and sides, a new game not leaving the
previous game's search statistics behind, and exactly when `revision` and
`position` change.

AI tests cover: all four levels returning a legal move within their time limit,
sliced progress under a tiny node budget, always capturing when it can, spotting a
forced win when the opponent's last piece can be taken, returning −1 when there is
no legal move, every move in a self-play game being legal, a return to an old
position counting as at most a draw, repetition not paying off when behind,
returning a legal move even when the search did not finish, game history not
leaking into later searches through the transposition table, and a search-speed
benchmark. The search-correctness tests compare the alpha-beta root score against a
naive minimax that uses **no pruning and no transposition table** at all; the two
must agree exactly.

API tests cover: static assets and directory traversal, CORS headers, the opening
state, move hints, an illegal move returning 409 without changing the position, the
AI replying, the human being refused while the AI is thinking, search progress,
undo, switching difficulty, changing sides restarting the game, agreeing to end,
404 on an unknown endpoint, the server speaking English by default, and **"the web
page and the terminal are looking at the same game"** — play a move or undo through
the API and the other side's next read must show it.

Text-table tests cover: the default language being English, the two languages
having exactly the same set of 185 keys, no empty strings, the same placeholders
for a given key in both languages (otherwise switching language produces half a
sentence or a literal `{n}`), no Chinese characters in English strings,
well-formed braces, `normalize` coping with junk input, a missing key falling back
to English and then to the key name, moves and all four kinds of ending rendering
in both languages, level names and side names, and intersection names being
language-independent. Two deliberate exceptions are listed explicitly:
`tui.help.langKeys` (the `L (中文 / English)` row in the help sheet) and the
language buttons on the web page — both **must** write the language names in their
own scripts, or nobody would know which to click, so the "no Chinese in English
strings" scan skips those two.

One of the browser tests is about language specifically: `tests/browser/i18n.js`
first checks that the English page contains **not one Chinese character** (by
scanning the whole page's text, which is much harder to fool than asserting on
individual elements), then that switching to Chinese changes the title, the
buttons, the level names and `<html lang>`, that **the same game's move log and
end-of-game message render in the other language while the pieces stay put
character for character**, that the choice survives a reload, and finally that play
continues normally after switching.

The terminal-UI tests (`tests/tui.test.js`) start `server.js` and `tui.js` for real
and feed keys in through a pipe, checking the characters that come out. What they
mostly watch for is **layout** — the likeliest thing to go wrong in a terminal UI
is not logic but drawing: a line wider than the screen wraps and the whole panel
falls apart, and one row too many clips the help sheet. So widths are measured in
**display columns** (a Chinese character counts as 2), not in characters. They
cover: English by default, `--plain` output being pure ASCII in English, `--lang zh`
switching to Chinese **with the board unchanged character for character**, the move
logs of the two languages corresponding move by move, `L` switching on the spot
(lower-case `l` only moves the cursor), the help overlay being complete and not
over-wide in either language, `--help`, the message and exit code when the backend
is unreachable, the too-small-screen message, and a move played through the API
showing up in the terminal. Two of these were added while fixing bugs: the "how it
plays" paragraph in the help sheet used to be clipped mid-sentence (English
sentences are longer than Chinese ones and overflowed the 59-column body width),
and `--plain` used to be a lie (the board glyphs became ASCII while `· ● → ’ × ↑↓←→`
in body text still went out as Unicode).

### Match tools (optional)

These are useful for seeing how the levels actually differ, or when tuning the
evaluation:

```bash
node tests/selfplay.js 4 1                 # level 4 as Black against level 1 as Red, one game with the move list
node tests/match.js 4 2 2 800              # several games each way between two levels, with win/loss and material totals
node tests/diagnose.js 4 2                 # per move, how many pieces the opponent could take straight afterwards
```

Both `tests/match.js` and `tests/selfplay.js` **keep each level's own random
slack**: that is what implements "occasionally misses one" at the lower levels, and
an earlier version that turned the randomness off to make a cleaner comparison
showed almost no difference between the levels and led to the wrong conclusion.

### Browser tests (optional, needs Chrome installed)

`tests/browser/` drives the interface in a real browser: real mouse events are sent
over the Chrome DevTools Protocol, and what is checked is "what happens when the
user clicks", rather than calling the page's own functions. No npm packages.

```bash
node server.js --port 8123         # in another terminal
node tests/browser/e2e.js          # online: moving, replying, undo, sides, all four levels, staying in sync
node tests/browser/i18n.js         # language switching: whole page, move log, end message, remembered choice
node tests/browser/offline.js      # offline (file://): playing in the page + a repaint regression for the path preview
```

One regression test in `offline.js` is worth explaining: **moving the mouse between
two capture targets must redraw the path preview.** An earlier implementation
decided whether to redraw from "is there a path at all", so moving between two
targets that both had paths left the canvas stuck on the first route. This test
compares canvas pixel fingerprints directly; looking only at the page's path data
would not catch it — reverting the code to the old approach does make this test
fail.

The `CHROME_PATH` environment variable can point at Chrome; by default the usual
macOS, Linux and Windows locations are tried in turn.

## API

The JSON API `server.js` provides (used by both front ends):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | The full current state (board, side to move, move log, AI progress…) |
| GET | `/api/hints?cell=N` | Every move for the piece on that intersection, captures with their route |
| POST | `/api/move` | `{"move": integer}`, play a move; 409 when it is the AI's turn or the move is illegal |
| POST | `/api/new` | `{"humanSide"?, "level"?}`, start a new game |
| POST | `/api/undo` | Undo, taking back one move by each side |
| POST | `/api/agree` | Agree to end, adjudicated on the pieces left |
| POST | `/api/level` | `{"level": 0..3}`, change difficulty |
| POST | `/api/side` | `{"side": 1|2}`, change which side you play (starts a new game) |

A move is encoded as `(from << 6) | to`, and intersections are numbered
`row * 6 + column`; `state.board` gives 0 (empty), 1 (Black) or 2 (Red). The state
also carries two counters: `revision` changes on anything at all (including the
AI's search progress), while `position` changes only when the position, the side to
move or the game's status really changes. The interface uses that to decide whether
the board needs redrawing.

## Adjudications a digital version has to make

The original rules leave "when neither side can make headway, the game is ended by
agreement and the player with more pieces wins" to the players. This implementation
handles it like this:

- There is an "agree to end" button/key, which adjudicates on the pieces left at
  any time (equal numbers is a draw).
- When the side to move has no legal move at all, the game ends automatically and
  is adjudicated by the same rule.

Apart from those two points, the rules, board geometry, opening setup and capture
rules all match the traditional game. One more thing: traditionally the players
toss a coin for who moves first; here Black always moves first, and you choose
whether to play Black or Red with the "play as" buttons.

## Debug entry points

- The page exposes `game` (current state), `ui` (interface state), `mode`
  (`http` / `local`), `refresh`, `draw`, `toCell`, `cellPoint`, `rules`, `ai`,
  `locale` and `setLocale('en'|'zh')`, and `t` (the text lookup for the current
  language) on `window.__surakarta`, so you can inspect the position, switch
  language or reproduce a problem from the console. Offline there is also
  `loadPosition(board, side)` to set up a position directly (online the position
  belongs to the backend and there is no such entry point).
- The server can be driven with `curl`, for example:

```bash
curl -s localhost:8123/api/state | head -c 200
curl -s -X POST -H 'Content-Type: application/json' -d '{"level":3}' localhost:8123/api/level
```

---

**English** | [中文](README.zh-CN.md)
