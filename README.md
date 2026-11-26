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

**Learns from the pros**
- *Learn from leaderboard* downloads the best shared runs for the robot you're driving (or robots of the same
  type) and studies them with the game's own replay reader.
- *Copy the pros* follows their auto route, shoots and passes from their spots, and picks up fuel where they did.
- *Learn from saved replays*, or drop `.frcreplay` files on the panel.
- A new lesson is tried for one match and kept only if it scores about as well as what the bot already had.

**Learns by itself**
- A separate strategy for every robot and every robot type (how it aims, hopper size, dumper or not),
  per mode: solo, multiplayer, defense only, bump defense only.
- Judged by the game's real score. Each match it tries small changes and keeps what scores more.
- Saves the replay (pause menu → Save replay) when it beats its personal best.

**Auto**
- Keeps the preload and swipes the densest strip of the centre fuel, then shoots from the nearest legal spot.
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
- Dumpers keep intaking; trenches only when the robot fits under the roof (hard-topped robots like
  2910 and 1690 even when full); intake kept down near trenches.
- Wall, tower and depot cleaning, intake-jam recovery, pin detection, trench back-out.

**Multiplayer**
- Readies up by itself (never presses Start in a room).
- Fills its hopper, then plays defense while its hub is off: keeps opponents in their zone, guards the bumps and
  trenches, blocks shots with MadTown 1323 (not against robots too tall to block).
- *Defense only* and *Bump defense only* switches. Backs off before pinning fouls and leaves climbers alone.

## Fair play

Use it in Singleplayer or in private rooms with friends who know a bot is playing.
The bot **switches itself off in Ranked**. (it does infact work in ranked it sucks dont waste elo)

## How it hooks into the game

The game is a Next.js/Turbopack app. The script wraps the module loader (or, if it loads late, borrows the
loader's module cache) to read the live match state — robots, fuel, hubs, score, phase — and drives with the
same keys a person uses. Learning is stored in your browser's `localStorage`; the panel can export/import it.

Built with [Claude Code](https://claude.com/claude-code).
