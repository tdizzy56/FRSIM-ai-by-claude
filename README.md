# FRSim Rebuilt Bot

A [Violentmonkey](https://violentmonkey.github.io/) userscript that drives your robot in
[FRSim Rebuilt](https://rebuilt.frsim.com/), learns from every match, and can learn from the
leaderboard's best players.

## Install

1. Install Violentmonkey in your browser.
2. Open [`frsim-rebuilt-bot.user.js`](frsim-rebuilt-bot.user.js), click **Raw**, and let Violentmonkey install it
   (or create a new script in Violentmonkey and paste the file in). Keep only one copy turned on.
3. Reload rebuilt.frsim.com, start a match, and press <kbd>`</kbd> (backquote) or click **Autopilot** in the panel.

Keep the game tab visible while it plays — browsers slow down scripts in background tabs.

## What it does

**Collects like the top players**
- Drives straight runs through the fuel flat out with the intake leading, picking the run that gets the most fuel per
  second (counting the drive back to shoot), instead of creeping from pile to pile.
- Tops up only while that beats the rate of the current cycle; every volley's stop-aim-spin-up time is counted.
- Shoots from just inside its zone where it crosses in (behind the bump or at the trench exit), turns toward the hub
  on the way in, and brakes instead of coasting past its spot.
- Singleplayer: collects anywhere on the field, including behind the other hub and down the trench lanes (robots that
  fit drive straight down the middle of the lane).
- Hub off: passes fuel into its own zone. Hub on: clears that stockpile with quick cycles, sliding along the back wall
  and shooting from wherever it picked the fuel up (in range), and still goes out when the neutral zone has more.
- Gives up on fuel it can't get (wedged against something) instead of sitting there; no false "intake jammed" from
  fuel already in its own hopper; a last ball that won't fire waits for the next load.
- Turns with the game's turn ramp in mind (holds the key, lets go early enough to coast onto the heading).

**Learns from the pros** (the *Learn from the pros* box on the panel)
- *Leaderboard* downloads the best shared runs for the robot you're driving (or robots of the same type) and studies
  them with the game's own replay reader.
- *Upload replays* (or drop `.frcreplay` files on the panel), or *Saved* for replays saved in this browser.
- *Copy the pros (1:1)* (singleplayer): replays the best learned run for your robot second by second — same path,
  same heading, shooting, passing and intaking when they did (mirrored if you're on the other alliance). Those matches
  don't change what the bot has learned for its own plan.
- Even with the switch off, it uses the pros' shooting spots and pickup runs (when there's fuel there now). A new
  lesson is tried for one match and kept only if it scores about as well as what the bot already had.

**High scores**
- *🏆 Post high score to GitHub* opens a ready-filled issue on this repo with your best score and robot; press Submit to
  post it (it uses your own GitHub login — the script never stores a GitHub token). The button lights up when you have
  a new best. [See posted scores](https://github.com/tdizzy56/FRSIM-ai-by-claude/issues?q=is%3Aissue+%22High+score%22+in%3Atitle).

**Learns by itself**
- A separate strategy for every robot and every robot type (how it aims, hopper size, dumper or not),
  per mode: solo, multiplayer, defense only, bump defense only.
- Judged by the game's real score. Each match it tries small changes and keeps what scores more.
- Saves the replay (pause menu → Save replay) when it beats its personal best.
- The panel shows *best match* (your highest score with that robot in that mode; it only changes on a new best) and
  *plan avg* (what the plan it's using has been scoring lately).

**Auto**
- Full loads only: picks the runs through the centre that fill the hopper in one pass, then shoots from just behind
  the bump. Dumpers do three full swipes.
- Turrets do two full swipes, then roll slowly to their depot shooting on the move and finish auto scooping the depot.
- Singleplayer uses the whole centre pile (across the middle too); multiplayer stays on its own half.

**Shifts**
- Hub on: goes where the fuel is (neutral zone first, its own zone in the last 5 s of a shift).
- Hub off: collects and passes, then comes back full and in position by 2 s before its shift.
- Fires ~2.5 s before its shift starts and keeps firing into the 3 s the hub still counts after it ends.
- Endgame: plans its last runs so the run, the drive back and the whole volley fit before the buzzer.

**Robots** (reads each robot's own setup from the game)
- Intake always faces the fuel; shoots only from inside its own alliance zone.
- Turrets shoot from anywhere in range and pass on the move; the intake wiggles in and out to feed
  robots it helps. Sweeping their own zone (the back wall) with the hub on, they keep the intake running and fire on
  the move instead of stopping to shoot. Every robot keeps just clear of the tower (no trips into its pocket). Turrets that can't spin all the way round (971, 118, 5460) turn the chassis to keep the hub in
  their swing.
- Dumpers (1833, 2481, and 5460) keep intaking except while shooting, come back full, and stop at the hub to dump.
  5460 has a turret and an expandable hopper but plays as a dumper: its turret is only used for aiming (and to
  jostle fuel into the shooter), never to shoot on the move.
- Expandable hoppers (1678, 5460): the lid goes up while collecting to hold more (5460 fills to 69 instead of the
  high 40s), it's bump-only while the lid is up, and the lid comes down before shooting, which feeds the shooter
  faster.
- Learns how much each hopper really holds, so a hopper that fills early is treated as full (and never as an
  "intake jam" that spits fuel back out).
- Trenches only when the robot fits under the roof. 2910, 1690, 118, 1323, 1360, 5000, 1678 and 5460 go under even when
  full with the hopper down; the intake and hopper are kept down near trenches.
- Wall, tower and depot cleaning, intake-jam recovery, pin detection, trench back-out.

**Multiplayer**
- Readies up by itself (never presses Start in a room).
- Fills its hopper, then plays defense while its hub is off: keeps opponents in their zone, guards the bumps and
  trenches, blocks shots with MadTown 1323 (not against robots too tall to block).
- *Defense only* and *Bump defense only* switches. Backs off before pinning fouls and leaves climbers alone.

## Fair play

Use it in Singleplayer or in private rooms with friends who know a bot is playing.
The bot **switches itself off in Ranked**. Use it in Singleplayer or private rooms.

## How it hooks into the game

The game is a Next.js/Turbopack app. The script wraps the module loader (or, if it loads late, borrows the
loader's module cache) to read the live match state — robots, fuel, hubs, score, phase — and drives with the
same keys a person uses. Learning is stored in your browser's `localStorage`; the panel can export/import it.

Built with [Claude Code](https://claude.com/claude-code).
