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

**Collects like the top players** (new in 2.0)
- Drives straight runs through the fuel flat out with the intake leading, picking the run that gets the most fuel per
  second (counting the drive back to shoot), instead of creeping from pile to pile.
- Shoots from just inside its zone where it crosses in (behind the bump or at the trench exit), turns toward the hub
  on the way in, and brakes instead of coasting past its spot.
- Cleans up big piles in its own zone and still goes out when the neutral zone has more.

**Learns from the pros** (the *Learn from the pros* box on the panel)
- *Leaderboard* downloads the best shared runs for the robot you're driving (or robots of the same type) and studies
  them with the game's own replay reader.
- *Upload replays* (or drop `.frcreplay` files on the panel), or *Saved* for replays saved in this browser.
- *Copy the pros* drives the same pickup runs they made (when there's fuel there now) and shoots and passes from their
  spots. A new lesson is tried for one match and kept only if it scores about as well as what the bot already had.

**High scores**
- *🏆 Post high score to GitHub* opens a ready-filled issue on this repo with your best score and robot; press Submit to
  post it (it uses your own GitHub login — the script never stores a GitHub token). The button lights up when you have
  a new best. [See posted scores](https://github.com/tdizzy56/FRSIM-ai-by-claude/issues?q=is%3Aissue+%22High+score%22+in%3Atitle).

**Learns by itself**
- A separate strategy for every robot and every robot type (how it aims, hopper size, dumper or not),
  per mode: solo, multiplayer, defense only, bump defense only.
- Judged by the game's real score. Each match it tries small changes and keeps what scores more.
- Saves the replay (pause menu → Save replay) when it beats its personal best.

**Auto**
- Keeps the preload and makes fast runs through the centre fuel, shooting each load from just behind the bump.
- Crosses the middle in singleplayer; stays on its own half in multiplayer.

**Shifts**
- Hub on: goes where the fuel is (neutral zone first, its own zone in the last 5 s of a shift).
- Hub off: collects and passes, then comes back full and in position by 2 s before its shift.
- Fires ~2.5 s before its shift starts and keeps firing into the 3 s the hub still counts after it ends.
- Endgame: fills up before going in to shoot.

**Robots** (reads each robot's own setup from the game)
- Intake always faces the fuel; shoots only from inside its own alliance zone.
- Turrets shoot from anywhere in range and pass on the move; the intake wiggles in and out to feed
  robots it helps.
- Dumpers keep intaking; trenches only when the robot fits under the roof. 2910, 1690, 118, 1323, 1360, 5000, 1678
  and 5460 go under even when full; the intake and hopper are kept down near trenches.
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
