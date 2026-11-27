// ==UserScript==
// @name         FRSim Rebuilt Learning Bot
// @namespace    frsim-rebuilt-bot
// @version      2.1.2
// @description  Drives your robot in FRSim Rebuilt and learns to score more fuel in each shift.
// @match        https://rebuilt.frsim.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '2.1.2';
  const OTHER_COPY = window.__frsimBot && window.__frsimBot.version !== VERSION ? (window.__frsimBot.version || 'older') : null;

  // ---------------------------------------------------------------------------
  // 1. Hook the game's module loader so we can read the live match state.
  //    The game is a Next.js/Turbopack app; every module registers its exports
  //    through ctx.s([...]). We wrap each module factory to capture those lists.
  // ---------------------------------------------------------------------------
  const EXPORTS = [];
  let CACHE = null; // the loader's module cache (Map id -> module), shared by every module context
  const wrapCtx = (ctx) => {
    if (!ctx || ctx.__frsBot) return ctx;
    try { if (!CACHE && ctx.c instanceof Map) CACHE = ctx.c; } catch (_) {}
    const orig = ctx.s;
    if (typeof orig === 'function') {
      ctx.s = function (list, id) {
        const r = orig.apply(this, arguments);
        try { EXPORTS.push(list); } catch (_) {}
        return r;
      };
    }
    try { ctx.__frsBot = true; } catch (_) {}
    return ctx;
  };
  const wrapChunk = (chunk) => {
    if (!Array.isArray(chunk)) return chunk;
    for (let i = 1; i < chunk.length; i++) {
      const f = chunk[i];
      if (typeof f === 'function' && !f.__frsBot) {
        const g = function (ctx, ...rest) { return f.call(this, wrapCtx(ctx), ...rest); };
        g.__frsBot = true;
        chunk[i] = g;
      }
    }
    return chunk;
  };
  const proxyFor = (target) => new Proxy(target, {
    get(t, k) {
      if (k === 'push') return (...chunks) => t.push(...chunks.map(wrapChunk));
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let realTP = window.TURBOPACK || [];
  if (Array.isArray(realTP)) realTP.forEach(wrapChunk);
  let tpProxy = proxyFor(realTP);
  try {
    Object.defineProperty(window, 'TURBOPACK', {
      configurable: true,
      get() { return tpProxy; },
      set(v) {
        realTP = v;
        if (Array.isArray(v)) v.forEach(wrapChunk);
        tpProxy = v && typeof v === 'object' ? proxyFor(v) : v;
      },
    });
  } catch (e) {
    console.warn('[FRSim bot] could not hook the game loader', e);
  }

  // If the script was injected after the game had already loaded its modules, we never saw them
  // register. Then we add one tiny module of our own and run it: the loader hands it a context
  // whose .c is the shared module cache, which holds everything the game already loaded.
  let probedAt = 0;
  const probeLoader = () => {
    if (CACHE || performance.now() - probedAt < 2000) return;
    probedAt = performance.now();
    const rt = realTP;
    if (!rt || Array.isArray(rt) || typeof rt.push !== 'function') return; // loader not started yet
    const id = 'frsim-bot-probe-' + Math.random().toString(36).slice(2);
    try {
      rt.push(['frsim-bot-probe.js', id, function (ctx) { try { if (ctx && ctx.c instanceof Map) CACHE = ctx.c; } catch (_) {} }]);
      rt.push(['frsim-bot-probe-run.js', { otherChunks: [], runtimeModuleIds: [id] }]);
    } catch (e) { console.warn('[FRSim bot] loader probe failed', e); }
  };
  const exportValues = function* () {
    if (CACHE) {
      for (const mod of CACHE.values()) {
        const ex = mod && mod.exports;
        if (!ex || typeof ex !== 'object') continue;
        let keys; try { keys = Object.keys(ex); } catch (_) { continue; }
        for (const k of keys) {
          let v; try { v = ex[k]; } catch (_) { continue; }
          if (v && typeof v === 'object') yield v;
        }
      }
    }
    for (const L of EXPORTS) {
      for (let i = 0; i < L.length; i++) {
        if (typeof L[i] !== 'string') continue;
        let v = L[i + 1];
        if (v === 0) v = L[i + 2];
        else if (typeof v === 'function' && v.length === 0) { try { v = v(); } catch (_) { v = null; } }
        if (v && typeof v === 'object') yield v;
      }
    }
  };

  let GAME = null; // { view, prev, ... } – the live render state
  const findGame = () => {
    if (GAME) return GAME;
    probeLoader();
    for (const v of exportValues()) {
      if ('view' in v && 'prev' in v && 'alpha' in v) { GAME = v; break; }
    }
    return GAME;
  };

  const robotCfgCache = new Map();
  // How tall a robot is (top of its collision hull). Tall shooters fire over a shot blocker.
  const heightCache = new Map();
  const robotTop = (team) => {
    if (heightCache.has(team)) return heightCache.get(team);
    const c = findRobotConfig(team);
    if (!c || !Array.isArray(c.hull)) return 0.55;
    let top = 0; for (const h of c.hull) if (h && h.centre && h.half) top = Math.max(top, h.centre[1] + h.half[1]);
    heightCache.set(team, top);
    return top;
  };
  // Does this robot fit under the trench roof right now? Robots with a hard top over the hopper (no net)
  // stay the same height when full; net-topped hoppers bulge up to the net's max height once well filled.
  // Robots players have checked fit under the trench even with a full hopper, as long as the hopper/intake is
  // kept down (the bot keeps the intake out and down whenever it's near a trench).
  const TRENCH_OK_FULL = new Set([2910, 1690, 118, 1323, 1360, 5000, 1678, 5460]);
  const fitsTrench = (team, fill) => {
    if (TRENCH_OK_FULL.has(team)) return true;
    const c = findRobotConfig(team), h = c && c.hopper, top = robotTop(team);
    let fullH = top;
    if (h && h.net && h.net.max != null) fullH = Math.max(top, h.net.max);
    else if (h && h.roof != null) fullH = Math.max(top, h.roof);
    const emptyH = h && h.net ? top : fullH;
    return (fill > 0.6 ? fullH : emptyH) < 0.565; // trench roof height
  };
  const TALL = 0.62; // 1323's blocker (hinge 0.55 m, 0.28 m plate) can't reliably reach shots from robots taller than this
  const findRobotConfig = (team) => {
    if (robotCfgCache.has(team)) return robotCfgCache.get(team);
    for (const v of exportValues()) {
      for (const c of Array.isArray(v) ? v : [v]) {
        if (c && c.number === team && c.intake && c.intake.mouth) {
          robotCfgCache.set(team, c);
          return c;
        }
      }
      // configs can also live one level down (team tables)
      if (!Array.isArray(v)) {
        for (const k in v) {
          let c; try { c = v[k]; } catch (_) { continue; }
          if (c && typeof c === 'object' && c.number === team && c.intake && c.intake.mouth) {
            robotCfgCache.set(team, c);
            return c;
          }
        }
      }
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // 2. Field geometry (metres, game world frame: x along field, z across it)
  // ---------------------------------------------------------------------------
  const FIELD = { halfX: 8.270494, halfZ: 4.034663 };
  const HUB_X = 4.625594 - 8.270494; // blue hub world x (red is mirrored)
  const HUB_HALF = 1.1938 / 2;
  const allianceSign = (a) => (a === 'blue' ? -1 : 1); // which half of the field is "ours"
  // blue hub at x = -3.645, red hub at x = +3.645
  const hubOf = (a) => ({ x: a === 'blue' ? HUB_X : -HUB_X, z: 0 });

  const SHIFT_PHASES = ['transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'];
  const PLAY_PHASES = ['auto', ...SHIFT_PHASES];

  // ---------------------------------------------------------------------------
  // 3. Learning memory (saved in localStorage so it survives reloads)
  // ---------------------------------------------------------------------------
  // Starting values = the "video playbook": what good drivers do in REBUILT —
  // grab fuel while your hub is off, be parked in range a few seconds before it
  // turns on, unload fast, and don't shoot into an inactive hub.
  const PARAMS = {
    shootDist:   { min: 1.7, max: 4.5, init: 2.6,  short: 'range', label: 'Shooting distance (m)' },
    shootAngle:  { min: -70, max: 70,  init: 0,    short: 'angle', label: 'Shooting angle (deg)' },
    minLoadFrac: { min: 0.1, max: 1.0, init: 0.55, short: 'load', label: 'Fuel before going to shoot' },
    density:     { min: 0,   max: 3,   init: 1,    short: 'piles', label: 'Prefer fuel piles' },
    reach:       { min: -2,  max: 4.0, init: 2.2,  short: 'reach', label: 'How far into neutral zone' },
    slowRadius:  { min: 0.3, max: 1.6, init: 0.8,  short: 'braking', label: 'Slow-down distance (m)' },
    plowPast:    { min: 0,   max: 1.2, init: 0.5,  short: 'plow', label: 'Drive past fuel by (m)' },
    oscPeriod:   { min: 0.4, max: 1.6, init: 0.8,  short: 'intake wiggle', label: 'Turret intake in/out cycle (s)' },
    postFire:    { min: 0,   max: 3,   init: 1.8,  short: 'post-fire', label: 'Keep shooting after our shift ends (s)' },
    preFire:     { min: 0,   max: 3.5, init: 2.5,  short: 'pre-fire', label: 'Start shooting before our shift (s)' },
    passLoad:    { min: 0.2, max: 1.0, init: 0.5,  short: 'pass load', label: 'Hopper full enough to pass' },
    prepTime:    { min: 1,   max: 10,  init: 5.5,    short: 'reload', label: 'Reload time before heading back (s)' },
    wallBias:    { min: 0,   max: 3,   init: 0.6,  short: 'wall', label: 'Prefer cleaning back wall' },
    sweepSpeed:  { min: 0.3, max: 1.0, init: 0.75, short: 'sweep', label: 'Wall sweep speed' },
    // defense (multiplayer only)
    shoveSpeed:  { min: 0.4, max: 1.0, init: 0.8,  short: 'shove', group: 'defense', label: 'Shove strength' },
    bumpPush:    { min: 0.6, max: 1.0, init: 1.0,  short: 'bump push', group: 'defense', label: 'Push strength on the bumps' },
    defLead:     { min: 0,   max: 9,   init: 5,    short: 'def early', group: 'defense', label: 'Leave to defend before our shift ends (s)' },
    blockDist:   { min: 0.9, max: 2.2, init: 1.1, short: 'block gap', group: 'blocker', label: 'Blocker distance from shooter (m)' },
    blockTwist:  { min: -90, max: 90,  init: 0,    short: 'block angle', group: 'blocker', label: 'Blocker angle to shot (deg)' },
  };
  const KEYS = Object.keys(PARAMS);
  const RETURN_AT = 2; // be back at our shooting spot with this many seconds left in the off shift
  const STORE = 'frsimRebuiltBot.v1';
  const GRID = { cell: 0.4, nx: Math.ceil((2 * FIELD.halfX) / 0.4), nz: Math.ceil((2 * FIELD.halfZ) / 0.4) };

  const defaultMemory = () => {
    const p = {}; const s = {};
    for (const k of KEYS) { p[k] = PARAMS[k].init; s[k] = (PARAMS[k].max - PARAMS[k].min) * 0.12; }
    return { best: { p, avg: null, n: 0 }, sigma: s, history: [], stuck: new Array(GRID.nx * GRID.nz).fill(0), matches: 0 };
  };
  let MEM;
  const loadMem = () => {
    try { MEM = JSON.parse(localStorage.getItem(STORE)); } catch (_) { MEM = null; }
    if (!MEM || !MEM.best) MEM = defaultMemory();
    if (!MEM.stuck || MEM.stuck.length !== GRID.nx * GRID.nz) MEM.stuck = new Array(GRID.nx * GRID.nz).fill(0);
    for (const k of KEYS) {
      if (typeof MEM.best.p[k] !== 'number') MEM.best.p[k] = PARAMS[k].init;
      if (typeof MEM.sigma[k] !== 'number') MEM.sigma[k] = (PARAMS[k].max - PARAMS[k].min) * 0.12;
    }
  };
  // Learning slots: singleplayer uses MEM.best/MEM.sigma; multiplayer keeps its own copy
  // (started from what singleplayer learned) so the two kinds of match don't skew each other.
  const slot = (mp) => {
    if (!mp) return MEM;
    const key = mp === 'def' ? 'def' : mp === 'bump' ? 'bump' : 'mp';
    if (!MEM[key] || !MEM[key].best) MEM[key] = { best: { p: { ...MEM.best.p }, avg: null, n: 0 }, sigma: { ...MEM.sigma } };
    const L = MEM[key];
    for (const k of KEYS) {
      if (typeof L.best.p[k] !== 'number') L.best.p[k] = MEM.best.p[k];
      if (typeof L.sigma[k] !== 'number') L.sigma[k] = MEM.sigma[k];
    }
    return L;
  };
  const modeKey = () => (B.multiplayer ? (SETTINGS.bumpOnly ? 'bump' : SETTINGS.defenseOnly ? 'def' : true) : false);
  const modeTag = (mk) => (mk === 'def' ? 'def' : mk === 'bump' ? 'bump' : mk ? 'mp' : 'solo');
  // Robot archetype, from how it's built: how it aims, how much it holds, and whether it dumps.
  const archOf = (team) => {
    const c = findRobotConfig(team); if (!c) return 'unknown';
    const br = c.brain || {}, turret = !!(c.shooter && c.shooter.turret);
    const aim = turret ? ((br.maxShotSpeed || 0) >= 2 ? 'turret-move' : 'turret') : 'chassis';
    const cap = (c.hopper && c.hopper.capacity) || 50;
    const size = cap >= 80 ? 'big' : cap >= 50 ? 'mid' : 'small';
    const lid = hasLid(c, team);
    const dumper = DUMPER_TEAMS.has(team) || (br.minRange || 1.4) <= 1.0;
    const tr = turret && c.shooter.turret.range, limited = tr && tr[0] != null && tr[1] != null && tr[1] - tr[0] < 2 * Math.PI - 0.1;
    return `${aim}${limited ? '-arc' : ''}/${size}${dumper ? '/dumper' : ''}${lid ? '/lid' : ''}`;
  };
  const newSlotFrom = (src) => ({ best: { p: { ...src.best.p }, avg: null, n: 0 }, sigma: { ...src.sigma } });
  const fillSlot = (L, from) => {
    for (const k of KEYS) {
      if (typeof L.best.p[k] !== 'number') L.best.p[k] = from.best.p[k] != null ? from.best.p[k] : PARAMS[k].init;
      if (typeof L.sigma[k] !== 'number') L.sigma[k] = from.sigma[k] != null ? from.sigma[k] : (PARAMS[k].max - PARAMS[k].min) * 0.12;
    }
    return L;
  };
  // Each robot keeps its own strategy per mode. A robot we haven't played yet starts from the best strategy
  // of its archetype (or of the mode, if that archetype is new too).
  const archSlot = (mk, team) => {
    MEM.slots = MEM.slots || {};
    const base = slot(mk), key = `${modeTag(mk)}|a:${archOf(team)}`;
    if (!MEM.slots[key]) MEM.slots[key] = newSlotFrom(base);
    return fillSlot(MEM.slots[key], base);
  };
  const robotSlot = (mk, team) => {
    MEM.slots = MEM.slots || {};
    const A = archSlot(mk, team), key = `${modeTag(mk)}|t:${team}`;
    if (!MEM.slots[key]) MEM.slots[key] = newSlotFrom(A.best.avg != null ? A : slot(mk));
    return fillSlot(MEM.slots[key], A);
  };
  const saveMem = () => { try { localStorage.setItem(STORE, JSON.stringify(MEM)); } catch (_) {} };
  loadMem();

  const SETTINGS_KEY = 'frsimRebuiltBot.settings';
  let SETTINGS = { enabled: false, autoReplay: true, explore: true, panelOpen: true, defense: true, autoReady: true, defenseOnly: false, bumpOnly: false, copyPros: true, replicatePros: false };
  try { Object.assign(SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch (_) {}
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (_) {} };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  // Pick this match's parameters: the best so far plus a small random nudge
  // ("try something slightly new"). Every 4th match replays the best set
  // unchanged so its average stays honest.
  const pickParams = (ctx = {}) => {
    const mk = ctx.slot != null ? ctx.slot : ctx.multiplayer;
    const L = ctx.team != null ? robotSlot(mk, ctx.team) : slot(mk);
    if (L.trial) { // a strategy learned from a replay: play it as-is this match
      const changed = KEYS.filter((k) => Math.abs((L.trial.p[k] ?? 0) - (L.best.p[k] ?? 0)) > 1e-6);
      return { p: { ...L.best.p, ...L.trial.p }, replay: false, changed, trial: L.trial.from };
    }
    const best = L.best.p;
    const replay = !SETTINGS.explore || L.best.avg === null || MEM.matches % 4 === 3;
    const p = {}; const changed = [];
    for (const k of KEYS) {
      let v = best[k];
      const g = PARAMS[k].group;
      const relevant = !g || (g === 'defense' && ctx.multiplayer) || (g === 'blocker' && ctx.multiplayer && ctx.blocker);
      if (!replay && relevant && Math.random() < 0.6) {
        v = clamp(v + gauss() * L.sigma[k], PARAMS[k].min, PARAMS[k].max);
        if (Math.abs(v - best[k]) > 1e-6) changed.push(k);
      }
      p[k] = v;
    }
    return { p, replay, changed };
  };

  // ---------------------------------------------------------------------------
  // Replay learning: read a replay with the game's own replay reader, follow one robot through the
  // match and measure how it played; then blend those numbers into that robot's strategy.
  // ---------------------------------------------------------------------------
  const findReplayLib = () => {
    if (CACHE) for (const mod of CACHE.values()) {
      const ex = mod && mod.exports;
      try { if (ex && typeof ex.J === 'function' && ex.J.prototype && ex.J.prototype.findMarks && typeof ex.r === 'function') return { J: ex.J, parse: ex.r }; } catch (_) {}
    }
    for (const L of EXPORTS) {
      const iJ = L.indexOf('J'), iR = L.indexOf('r');
      if (iJ < 0 || iR < 0) continue;
      const val = (i) => (L[i + 1] === 0 ? L[i + 2] : L[i + 1]);
      const J = val(iJ), r = val(iR);
      if (typeof J === 'function' && J.prototype && J.prototype.findMarks && typeof r === 'function') return { J, parse: r };
    }
    return null;
  };
  // seconds since the start of auto, from the phase and its clock
  const PHASE_T = { auto: [0, 20], gap: [20, 3], transition: [23, 10], shift1: [33, 25], shift2: [58, 25], shift3: [83, 25], shift4: [108, 25], endgame: [133, 30] };
  const matchTime = (ph, clk) => { const p = PHASE_T[ph]; return p ? p[0] + (p[1] - (clk || 0)) : null; };
  const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const pctl = (a, q) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * q))]; };

  const analyzeReplay = (bytes, wantTeam) => {
    probeLoader();
    const lib = findReplayLib();
    if (!lib) throw new Error('The game’s replay reader isn’t loaded yet — open the game first');
    const rp = lib.parse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const metaRobots = (rp.meta && rp.meta.robots) || rp.start.robots;
    let idx = metaRobots.findIndex((r) => r.team === wantTeam);
    if (idx < 0) idx = rp.meta && rp.meta.you != null ? rp.meta.you : 0;
    const rid = (rp.start.robots[idx] || rp.start.robots[0]).id;
    const pl = new lib.J(rp, rid);
    const S = [];
    for (let t = 0; t <= pl.duration; t += 100) {
      pl.show(t);
      const v = pl.view, r = v.robots.find((q) => q.id === rid) || v.robots[idx];
      if (!r) continue;
      const sc = v.score && v.score[r.alliance];
      S.push({ t, ph: v.phase, clk: v.clock || 0, x: r.pos[0], z: r.pos[2], yaw: r.quat ? yawOf(r.quat) : 0, st: r.state || '', hop: r.hopperFuel || 0, cap: r.hopperCapacity || 0,
        al: r.alliance, on: !!(v.hubs && v.hubs[r.alliance] && v.hubs[r.alliance].active), team: r.team,
        pts: sc ? (sc.autoFuel || 0) + (sc.teleFuel || 0) : 0, total: sc ? sc.total || 0 : 0 });
    }
    if (S.length < 20) throw new Error('That replay is too short to learn from');
    const team = S[0].team, al = S[0].al, cap = Math.max(...S.map((q) => q.cap)) || 50;
    const s = allianceSign(al), wallX = s * FIELD.halfX, inward = -s, hub = hubOf(al);
    const depth = (q) => (q.x - wallX) * inward;
    const shifts = /^(transition|shift[1-4]|endgame)$/;
    // volleys = runs of the hopper going down
    const runs = [];
    for (let i = 1; i < S.length; i++) {
      if (S[i].hop < S[i - 1].hop) {
        const last = runs[runs.length - 1];
        if (last && i - last.end <= 6) { last.end = i; last.lost += S[i - 1].hop - S[i].hop; }
        else runs.push({ start: i - 1, end: i, lost: S[i - 1].hop - S[i].hop });
      }
    }
    const shots = [], passes = [];
    for (const run of runs) {
      if (run.lost < 4) continue;
      const a = S[run.start];
      if (depth(a) < ZONE_DEPTH - 0.2) shots.push(run); else if (depth(a) > ZONE_DEPTH + 0.3) passes.push(run);
    }
    const out = { team, cap, alliance: al, score: S[S.length - 1].total, shots: shots.length, passes: passes.length, params: {} };
    const tele = shots.filter((r) => shifts.test(S[r.start].ph));
    if (tele.length) {
      const d = tele.map((r) => Math.hypot(S[r.start].x - hub.x, S[r.start].z - hub.z));
      const ang = tele.map((r) => { const q = S[r.start]; return (Math.atan2(Math.abs(q.z - hub.z), Math.abs(q.x - hub.x)) * 180) / Math.PI; });
      out.params.shootDist = median(d); out.params.shootAngle = median(ang);
      out.params.minLoadFrac = median(tele.map((r) => S[r.start].hop / cap));
      // fired before the hub came on: how many seconds early
      const early = tele.filter((r) => !S[r.start].on && /^shift[1-4]$/.test(S[r.start].ph)).map((r) => S[r.start].clk);
      if (early.length) out.params.preFire = median(early.filter((c) => c < 4));
      // kept firing after the hub went off: how long
      const late = [];
      for (const r of tele) for (let i = r.start + 1; i <= r.end; i++) if (S[i - 1].on && !S[i].on) { late.push((S[r.end].t - S[i].t) / 1000); break; }
      if (late.length) out.params.postFire = median(late);
    }
    if (passes.length) out.params.passLoad = median(passes.map((r) => S[r.start].hop / cap));
    // what to copy: where they shot, passed and picked up, and their whole auto route (blue-side coordinates)
    const N = (q) => (al === 'blue' ? [q.x, q.z] : [-q.x, -q.z]);
    const heat = {};
    for (let i = 1; i < S.length; i++) if (S[i].hop > S[i - 1].hop && shifts.test(S[i].ph)) {
      const [nx, nz] = N(S[i]); const key = Math.round(nx / 0.8) + ',' + Math.round(nz / 0.8);
      heat[key] = (heat[key] || 0) + (S[i].hop - S[i - 1].hop);
    }
    const autoStart = S.find((q) => q.ph === 'auto');
    const auto = [];
    if (autoStart) for (let i = 1; i < S.length; i++) {
      const q = S[i]; if (q.ph !== 'auto' || i % 2) continue;
      const [nx, nz] = N(q); auto.push([+((q.t - autoStart.t) / 1000).toFixed(2), +nx.toFixed(2), +nz.toFixed(2), S[i].hop < S[i - 1].hop ? 1 : 0]);
    }
    // their pickup runs: stretches where the hopper filled up (start and end point, how much, and when:
    // 0 auto, 1 hub on, 2 hub off, 3 endgame), so we can drive the same lines when there's fuel there
    const fills = [];
    let run = null;
    const closeRun = () => {
      if (run && run.gain >= 6) {
        const a0 = N(S[run.i0]), a1 = N(S[run.i1]), q = S[run.i0];
        const code = q.ph === 'auto' ? 0 : q.ph === 'endgame' ? 3 : q.on ? 1 : 2;
        fills.push([...a0, ...a1].map((v) => +v.toFixed(2)).concat([run.gain, code]));
      }
      run = null;
    };
    for (let i = 1; i < S.length; i++) if (S[i].hop > S[i - 1].hop) {
      if (run && i - run.i1 <= 3) { run.i1 = i; run.gain += S[i].hop - S[i - 1].hop; }
      else { closeRun(); run = { i0: i - 1, i1: i, gain: S[i].hop - S[i - 1].hop }; }
    }
    closeRun();
    // their whole match as a track to replay 1:1: [match time s, x, z, heading, what they were doing]
    // (blue-side coordinates; what: 1 shooting, 2 passing, 4 intaking)
    const track = [];
    for (let i = 1; i < S.length; i++) {
      const q = S[i], tm = matchTime(q.ph, q.clk); if (tm == null) continue;
      const [nx, nz] = N(q), yawN = al === 'blue' ? q.yaw : wrap(q.yaw + Math.PI);
      const falling = q.hop < S[i - 1].hop, rising = q.hop > S[i - 1].hop, inZone = depth(q) < ZONE_DEPTH - 0.4;
      const act = (/SCOR/.test(q.st) || (falling && inZone) ? 1 : 0) | (/PASS/.test(q.st) || (falling && !inZone) ? 2 : 0) | (rising ? 4 : 0);
      track.push([+tm.toFixed(2), +nx.toFixed(2), +nz.toFixed(2), +yawN.toFixed(2), act]);
    }
    out.v = 3;
    out.copy = {
      fills, track,
      shots: tele.map((r) => N(S[r.start]).map((v) => +v.toFixed(2))),
      passes: passes.map((r) => N(S[r.start]).map((v) => +v.toFixed(2))),
      heat, auto,
    };
    const toward = -s, far = S.filter((q) => shifts.test(q.ph)).map((q) => toward * q.x);
    if (far.length) out.params.reach = pctl(far, 0.97); // its deepest trips, not where it spends most time
    for (const k of Object.keys(out.params)) {
      const v = out.params[k];
      if (v == null || !isFinite(v)) delete out.params[k]; else out.params[k] = clamp(v, PARAMS[k].min, PARAMS[k].max);
    }
    return out;
  };

  // blend what we measured into that robot's strategy (all modes it plays scoring in)
  const applyReplayLesson = (res, weight = 0.65, forTeam = res.team) => {
    const keys = Object.keys(res.params);
    if (!keys.length) return 0;
    for (const mk of [false, true]) {
      for (const L of [robotSlot(mk, forTeam), archSlot(mk, forTeam)]) {
        // try it next match; it's kept only if it scores at least about as well as what we had
        const p = { ...L.best.p };
        for (const k of keys) p[k] = clamp(weight * res.params[k] + (1 - weight) * L.best.p[k], PARAMS[k].min, PARAMS[k].max);
        L.trial = { p, from: res.by ? `${res.by}'s ${res.points}-point run` : `a ${res.score}-point replay` };
      }
    }
    MEM.lessons = MEM.lessons || [];
    MEM.lessons.push({ t: Date.now(), team: res.team, score: res.score, params: res.params });
    if (res.copies && res.copies.length) {
      // merge the pros' spots and keep the best run's auto route, for the robot we're learning for
      MEM.copy = MEM.copy || {};
      const C = { from: [], shots: [], passes: [], fills: [], heat: {}, auto: null, autoScore: 0 };
      for (const c of res.copies) {
        C.from.push(c.who);
        C.shots.push(...(c.copy.shots || [])); C.passes.push(...(c.copy.passes || [])); C.fills.push(...(c.copy.fills || []));
        for (const [k, v] of Object.entries(c.copy.heat || {})) C.heat[k] = (C.heat[k] || 0) + v;
        if ((c.copy.auto || []).length > 20 && c.score > C.autoScore) { C.auto = c.copy.auto; C.autoScore = c.score; C.autoBy = c.who; }
        if ((c.copy.track || []).length > 100 && c.score > (C.trackScore || -1)) { C.track = c.copy.track; C.trackScore = c.score; C.trackBy = c.who; }
      }
      C.shots = C.shots.slice(0, 80); C.passes = C.passes.slice(0, 80); C.fills = C.fills.slice(0, 150);
      MEM.copy[forTeam] = C;
    }
    if (MEM.lessons.length > 50) MEM.lessons.shift();
    saveMem();
    return keys.length;
  };
  const describeLesson = (res) => {
    const p = res.params, bits = [];
    if (p.shootDist != null) bits.push(`shoots from ${p.shootDist.toFixed(1)} m`);
    if (p.minLoadFrac != null) bits.push(`shoots at ${Math.round(p.minLoadFrac * 100)}% full`);
    if (p.passLoad != null) bits.push(`passes at ${Math.round(p.passLoad * 100)}% full`);
    if (p.preFire != null) bits.push(`fires ${p.preFire.toFixed(1)} s early`);
    if (p.postFire != null) bits.push(`keeps firing ${p.postFire.toFixed(1)} s after`);
    if (p.reach != null) bits.push(`goes ${p.reach.toFixed(1)} m past centre`);
    return `${res.team} (score ${res.score}): ` + (bits.join(', ') || 'nothing clear to learn');
  };
  // replays the game keeps in this browser (yours and the bot's saved ones)
  const readSavedReplays = () => new Promise((resolve) => {
    let req; try { req = indexedDB.open('rebuilt-replays'); } catch (_) { return resolve([]); }
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result, out = [], stores = [...db.objectStoreNames];
      if (!stores.length) return resolve([]);
      let left = stores.length;
      for (const st of stores) {
        const tx = db.transaction(st, 'readonly'), os = tx.objectStore(st), all = os.getAll();
        all.onsuccess = () => { for (const v of all.result || []) if (v && (v.byteLength || v.length)) out.push(v); if (--left === 0) resolve(out); };
        all.onerror = () => { if (--left === 0) resolve(out); };
      }
    };
  });
  // The game's leaderboard module: B() asks the server for the board, h() is the replay download address.
  const findBoardLib = () => {
    const ok = (h, Bf) => { try { return typeof h === 'function' && typeof Bf === 'function' && /rebuilt-replays/.test(String(h())); } catch (_) { return false; } };
    if (CACHE) for (const mod of CACHE.values()) { const ex = mod && mod.exports; try { if (ex && ok(ex.h, ex.B)) return { board: ex.B, base: ex.h() }; } catch (_) {} }
    for (const L of EXPORTS) {
      const val = (n) => { const i = L.indexOf(n); return i < 0 ? undefined : (L[i + 1] === 0 ? L[i + 2] : L[i + 1]); };
      if (ok(val('h'), val('B'))) return { board: val('B'), base: val('h')() };
    }
    return null;
  };
  // Study the best shared leaderboard runs for this robot (or robots of the same type if it has none).
  const learnFromLeaderboard = async (team, onStatus) => {
    probeLoader();
    const lib = findBoardLib();
    if (!lib) throw new Error('the game’s leaderboard isn’t loaded yet');
    const board = await Promise.race([lib.board(true), new Promise((_, rej) => setTimeout(() => rej(new Error('the leaderboard server didn’t answer')), 20000))]);
    const runs = ((board && board.entries) || []).filter((e) => e.replay);
    let pick = runs.filter((e) => e.team === team), how = `${team}'s best runs`;
    if (!pick.length) { const arch = archOf(team); pick = runs.filter((e) => archOf(e.team) === arch); how = `best runs by ${arch} robots`; }
    if (!pick.length) { pick = runs; how = 'best runs on the board'; }
    pick.sort((x, y) => y.points - x.points);
    pick = pick.slice(0, 3);
    if (!pick.length) throw new Error('no shared replays on the leaderboard');
    MEM.boardLessons = MEM.boardLessons || {};
    const results = [];
    for (const e of pick) {
      if (MEM.boardLessons[e.replay] && MEM.boardLessons[e.replay].v === 3) { results.push(MEM.boardLessons[e.replay]); continue; }
      onStatus && onStatus(`Downloading ${e.name}'s ${e.points}-point run…`);
      try {
        const r = await fetch(`${lib.base}/${encodeURIComponent(e.replay)}`);
        if (!r.ok) throw new Error('replay server answered ' + r.status);
        const res = analyzeReplay(new Uint8Array(await r.arrayBuffer()), e.team);
        res.by = e.name; res.points = e.points;
        MEM.boardLessons[e.replay] = res;
        results.push(res);
      } catch (err) { console.warn('[FRSim bot] leaderboard replay', e.replay, err); }
    }
    if (!results.length) throw new Error('none of those replays could be read');
    return { results, how };
  };
  const learnFromBytesList = async (list, team) => {
    const results = [];
    for (const bytes of list) { try { results.push(analyzeReplay(bytes, team)); } catch (e) { console.warn('[FRSim bot] replay', e); } }
    return results;
  };

  // ---------------------------------------------------------------------------
  // 4. Keyboard output (the bot drives with the same keys you would)
  // ---------------------------------------------------------------------------
  const KEY_NAME = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyJ: 'j', KeyL: 'l', KeyX: 'x', KeyE: 'e', KeyQ: 'q', ShiftLeft: 'Shift', Space: ' ', Escape: 'Escape' };
  const held = new Set();
  const sendKey = (code, down) => {
    if (down === held.has(code)) return;
    if (down) held.add(code); else held.delete(code);
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code, key: KEY_NAME[code] || code, bubbles: true, cancelable: true, shiftKey: code === 'ShiftLeft' && down,
    }));
  };
  const releaseAll = () => { for (const k of [...held]) sendKey(k, false); };
  // a short press (used for toggles like the shot blocker); released on a later tick
  const taps = new Map();
  const tapKey = (code, now) => {
    if (taps.has(code) || now - (tapKey.last[code] || 0) < 450) return;
    tapKey.last[code] = now; sendKey(code, true); taps.set(code, now + 130); // long enough for a slow frame to see it
  };
  tapKey.last = {};
  const releaseTaps = (now) => { for (const [k, t] of taps) if (now >= t) { sendKey(k, false); taps.delete(k); } };

  // sigma-delta "PWM": lets on/off keys produce partial speeds
  const pwm = { fwd: 0, side: 0, rot: 0 };
  const axis = (name, value, posKey, negKey) => {
    const mag = clamp(Math.abs(value), 0, 1);
    pwm[name] += mag;
    let on = false;
    if (pwm[name] >= 1) { pwm[name] -= 1; on = true; }
    if (mag < 0.02) { pwm[name] = 0; on = false; }
    sendKey(posKey, on && value > 0);
    sendKey(negKey, on && value < 0);
  };

  // ---------------------------------------------------------------------------
  // 5. Helpers: robot pose, intake direction, fuel, path planning
  // ---------------------------------------------------------------------------
  const yawOf = (q) => Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  // Yaw that points the intake mouth at world direction (dx, dz).
  // mouthSign = side of the robot the intake is on (from the robot's own config).
  const yawToFace = (dx, dz, mouthSign) => Math.atan2(-mouthSign * dz, mouthSign * dx);

  const cellOf = (x, z) => {
    const i = clamp(Math.floor((x + FIELD.halfX) / GRID.cell), 0, GRID.nx - 1);
    const j = clamp(Math.floor((z + FIELD.halfZ) / GRID.cell), 0, GRID.nz - 1);
    return j * GRID.nx + i;
  };
  const cellCentre = (c) => ({ x: (c % GRID.nx + 0.5) * GRID.cell - FIELD.halfX, z: (Math.floor(c / GRID.nx) + 0.5) * GRID.cell - FIELD.halfZ });

  // Field pieces from the game's own layout (blue side; red is the same turned 180°).
  const ZONE_DEPTH = 4.028694; // alliance zone depth from the wall (trench/bump line)
  const BLUE_RECTS = {
    depot: { x0: -8.2705, x1: -7.5847, z0: -2.4638, z1: -1.3970 },
    tower: { x0: -8.2705, x1: -7.1229, z0: -0.2064, z1: 0.7839 },
    postA: { x0: -4.2418, x1: -3.0480, z0: 2.4513, z1: 2.7561 },
    postB: { x0: -4.2418, x1: -3.0480, z0: -2.7561, z1: -2.4513 },
  };
  // bumps (ramps beside each hub) and trench lanes (under the low trench roof, along the side walls)
  const BUMP_X = [4.0618 - 8.2705, 5.1895 - 8.2705]; // blue side; red is mirrored
  const inBump = (x, z) => Math.abs(x) > -BUMP_X[1] && Math.abs(x) < -BUMP_X[0] && Math.abs(z) > 0.597 && Math.abs(z) < 2.451;
  const inTrench = (x, z) => Math.abs(x) > 3.048 && Math.abs(x) < 4.242 && Math.abs(z) > 2.756;
  const TRENCH_CLEAR = 0.565; // trench roof height
  const rectFor = (name, a) => {
    const r = BLUE_RECTS[name];
    return a === 'blue' ? r : { x0: -r.x1, x1: -r.x0, z0: -r.z1, z1: -r.z0 };
  };
  const inRect = (r, x, z, pad = 0) => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;

  const staticBlocked = (() => {
    const b = new Uint8Array(GRID.nx * GRID.nz);
    const pad = HUB_HALF + 0.45;
    for (let c = 0; c < b.length; c++) {
      const { x, z } = cellCentre(c);
      for (const hx of [HUB_X, -HUB_X]) if (Math.abs(x - hx) < pad && Math.abs(z) < pad) b[c] = 1;
      if (Math.abs(x) > FIELD.halfX - 0.35 || Math.abs(z) > FIELD.halfZ - 0.35) b[c] = 1;
      for (const a of ['blue', 'red']) {
        if (inRect(rectFor('tower', a), x, z, 0.5)) b[c] = 1;
        if (inRect(rectFor('depot', a), x, z, 0.35)) b[c] = 1; // its low rail snags robots: only enter it on purpose
        if (inRect(rectFor('postA', a), x, z, 0.6) || inRect(rectFor('postB', a), x, z, 0.6)) b[c] = 1;
      }
    }
    return b;
  })();

  // ---- pin detection helpers (field geometry) ----
  // Is this point inside a wall or a solid field element (hub, tower, trench post)?
  const solidAt = (x, z) => {
    if (Math.abs(x) > FIELD.halfX - 0.03 || Math.abs(z) > FIELD.halfZ - 0.03) return true;
    for (const hx of [HUB_X, -HUB_X]) if (Math.abs(x - hx) < HUB_HALF + 0.03 && Math.abs(z) < HUB_HALF + 0.03) return true;
    for (const a of ['blue', 'red']) {
      if (inRect(rectFor('tower', a), x, z) || inRect(rectFor('postA', a), x, z) || inRect(rectFor('postB', a), x, z)) return true;
    }
    return false;
  };
  // Is a robot at (x, z) up against something solid on the side facing direction (dx, dz)?
  const againstSolid = (x, z, dx, dz) => {
    const n = Math.hypot(dx, dz) || 1;
    for (const d of [0.5, 0.62, 0.75]) if (solidAt(x + (dx / n) * d, z + (dz / n) * d)) return true;
    return false;
  };

  // Other robots on the field (partners, opponents, practice bots). Updated every tick.
  let OTHERS = [];
  const robotNear = (x, z, r) => OTHERS.some((o) => Math.hypot(o.x - x, o.z - z) < r);
  const robotCost = (x, z) => {
    let c = 0;
    for (const o of OTHERS) {
      // look a little ahead of where a moving robot is going
      const d = Math.min(Math.hypot(o.x - x, o.z - z), Math.hypot(o.x + o.vx * 0.6 - x, o.z + o.vz * 0.6 - z));
      if (d < 0.95) c += 8; else if (d < 1.6) c += 1.5 * (1.6 - d);
    }
    return c;
  };

  // A* over a coarse grid. Cells where the robot got stuck before cost more, and so do cells near robots.
  const planPath = (from, to) => {
    const N = GRID.nx * GRID.nz;
    const start = cellOf(from.x, from.z), goal = cellOf(to.x, to.z);
    if (start === goal) return [to];
    const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const open = [start]; g[start] = 0;
    const gc = cellCentre(goal);
    const h = (c) => { const p = cellCentre(c); return Math.hypot(p.x - gc.x, p.z - gc.z); };
    const f = new Float32Array(N).fill(Infinity); f[start] = h(start);
    let iter = 0;
    while (open.length && iter++ < 4000) {
      let bi = 0; for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) break;
      closed[cur] = 1;
      const ci = cur % GRID.nx, cj = Math.floor(cur / GRID.nx);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= GRID.nx || nj >= GRID.nz) continue;
        const nc = nj * GRID.nx + ni;
        if (closed[nc]) continue;
        if (staticBlocked[nc] && nc !== goal && nc !== start) continue;
        const cc = cellCentre(nc);
        if (B.noTrench && inTrench(cc.x, cc.z) && nc !== goal) continue; // won't fit under the trench roof
        const slow = inBump(cc.x, cc.z) ? 0.25 : 0;                      // ramps: a little slower (top players cross them flat out)
        const step = (di && dj ? 1.414 : 1) * GRID.cell * (1 + slow + 1.5 * Math.min(MEM.stuck[nc], 6) + (OTHERS.length ? robotCost(cc.x, cc.z) : 0));
        const ng = g[cur] + step;
        if (ng < g[nc]) {
          g[nc] = ng; came[nc] = cur; f[nc] = ng + h(nc);
          if (!open.includes(nc)) open.push(nc);
        }
      }
    }
    if (came[goal] === -1) return [to];
    const path = [];
    for (let c = came[goal]; c !== -1 && c !== start; c = came[c]) path.unshift(cellCentre(c));
    path.push(to);
    return path;
  };

  const floorFuel = (view, me) => {
    const F = view.fuel; if (!F || !F.pos) return [];
    const out = [];
    const ownHub = hubOf(me.alliance), oppHub = hubOf(me.alliance === 'blue' ? 'red' : 'blue');
    const W = F.where && F.where.length >= F.count ? F.where : null;
    const now = performance.now();
    if (B.badFuel && B.badFuel.length) B.badFuel = B.badFuel.filter((q) => q.until > now);
    for (let i = 0; i < F.count; i++) {
      const x = F.pos[3 * i], y = F.pos[3 * i + 1], z = F.pos[3 * i + 2];
      if (!(y < 0.2) || Math.abs(x) > FIELD.halfX + 0.05 || Math.abs(z) > FIELD.halfZ + 0.05) continue;
      if (W) { if (W[i] > 1) continue; } // the game says it's in a robot, the hub or the outpost
      else {
        // (older game versions) fuel already inside a robot (ours included) is not on the floor
        let held = false;
        for (const r of view.robots) if (Math.abs(r.pos[0] - x) < 0.5 && Math.abs(r.pos[2] - z) < 0.5) { held = true; break; }
        if (held) continue;
      }
      // spots we tried and couldn't pick up (wedged against something): leave them alone for a while
      if (B.badFuel && B.badFuel.some((q) => Math.hypot(q.x - x, q.z - z) < 0.55)) continue;
      if ((Math.abs(x - ownHub.x) < HUB_HALF + 0.1 && Math.abs(z) < HUB_HALF + 0.1) ||
          (Math.abs(x - oppHub.x) < HUB_HALF + 0.1 && Math.abs(z) < HUB_HALF + 0.1)) continue;
      out.push(x, z);
    }
    return out;
  };

  // ---- Straight runs (how the top players collect) ----
  // Instead of creeping from pile to pile, drive a straight line through the fuel flat out with the
  // intake leading. Every few tenths of a second, look at runs starting where we are (and from the end of
  // nearby strips of fuel) and take the one that picks up the most fuel per second, counting the drive
  // back to shoot when we're about to shoot.
  const runClear = (x, z, hw, lane) => {
    if (Math.abs(x) > FIELD.halfX - hw - 0.005 || Math.abs(z) > FIELD.halfZ - hw - 0.005) return false;
    if (Math.abs(x) > FIELD.halfX - hw - 0.45 && Math.abs(z) > FIELD.halfZ - hw - 0.45) return false; // field corners: robots wedge there
    for (const hx of [HUB_X, -HUB_X]) if (Math.abs(x - hx) < HUB_HALF + hw + 0.08 && Math.abs(z) < HUB_HALF + hw + 0.08) return false;
    const ax = Math.abs(x), az = Math.abs(z);
    if (ax > 3.048 - hw - 0.1 && ax < 4.242 + hw + 0.1 && az > 2.451 - hw - 0.02) {
      // trench mouths and posts: only straight down the middle of the lane, and only if we fit under the roof
      if (!(lane && Math.abs(az - LANE_Z) < 0.16)) return false;
    }
    for (const a of ['blue', 'red']) {
      if (inRect(rectFor('tower', a), x, z, hw + 0.15) || inRect(rectFor('depot', a), x, z, hw * 0.7)) return false; // just clear of the tower
    }
    return true;
  };
  // o: { hw, mouth, reach, v, capLeft, yaw, mouthSign, back(x, z) -> s, weight(x, z), lines: [[x0, z0, x1, z1]] }
  const planRun = (fuel, me, o) => {
    const corridor = o.mouth + 0.09;
    const backNow = o.back ? o.back(me.x, me.z) : 0; // the drive home we owe anyway
    let best = null;
    const evalLine = (x0, z0, dx, dz, pre, bonus, tag) => {
      const ts = [];
      for (let i = 0; i < fuel.length; i += 2) {
        const rx = fuel[i] - x0, rz = fuel[i + 1] - z0;
        const t = rx * dx + rz * dz;
        if (t < (pre ? -0.3 : 0.15) || t > 5.6) continue;
        const nearWall = Math.abs(fuel[i]) > FIELD.halfX - 0.3 || Math.abs(fuel[i + 1]) > FIELD.halfZ - 0.3;
        if (Math.abs(rz * dx - rx * dz) > corridor + (nearWall ? 0.08 : 0)) continue;
        ts.push([t, o.weight ? o.weight(fuel[i], fuel[i + 1]) : 1]);
      }
      if (ts.length < 2) return null;
      ts.sort((p, q) => p[0] - q[0]);
      let maxL = 0;
      const lane = o.trench && Math.abs(dz) < 0.06; // along a trench lane (only if we fit)
      for (let L = 0.2; L <= 5.2; L += 0.2) { if (!runClear(x0 + dx * L, z0 + dz * L, o.hw, lane)) break; maxL = L; }
      if (maxL < 0.4 && !pre) return null;
      // turning the intake to face the run happens while we drive, but a big turn costs a little
      const turn = pre ? 0.15 : Math.abs(wrap(yawToFace(dx, dz, o.mouthSign) - o.yaw)) / 5;
      let w = 0, out = null;
      for (const [t, wt] of ts) {
        const L = Math.max(0.3, t - o.reach + 0.2); // the intake is out in front: stop once it has passed the fuel
        if (L > maxL + 0.05) break;
        w += wt;
        if (w < 1.5) continue;
        const got = Math.min(w, o.capLeft);
        const ex = x0 + dx * L, ez = z0 + dz * L;
        const fills = got >= o.capLeft - 0.5;
        // has to fit before the buzzer (or our hub going off): the run, the drive back, aiming, and firing the whole load
        if (o.deadline != null && pre + turn + L / o.v + (o.back ? o.back(ex, ez) : 0) + (o.hop + got) / o.fireRate + 0.5 > o.deadline) break;
        // extra time this run adds to the cycle: driving it, plus however much further from home it leaves us
        const time = Math.max(0.8, pre + turn + L / o.v + 0.3 + (o.back ? o.back(ex, ez) - backNow : 0)); // every run costs a moment
        const rate = ((got * bonus) / time) * (o.preferFill && !fills ? 0.6 : 1);
        if (!out || rate > out.rate) out = { rate, x0, z0, x1: ex, z1: ez, dx, dz, L, n: got, pre: pre > 0, tag, firstT: ts[0][0] };
        if (fills) break;
      }
      return out;
    };
    const offer = (c) => { if (c && (!best || c.rate > best.rate)) best = c; };
    // 1) straight from here
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      offer(evalLine(me.x, me.z, Math.cos(a), Math.sin(a), 0, 1));
    }
    // 2) go to the end of a strip of fuel first, then run down it
    const bins = new Map();
    for (let i = 0; i < fuel.length; i += 2) {
      const key = Math.floor(fuel[i] / 0.8) * 1000 + Math.floor(fuel[i + 1] / 0.8);
      const b = bins.get(key) || { n: 0, x: 0, z: 0 }; b.n++; b.x += fuel[i]; b.z += fuel[i + 1]; bins.set(key, b);
    }
    const top = [...bins.values()].filter((b) => b.n >= 3)
      .map((b) => ({ x: b.x / b.n, z: b.z / b.n, n: b.n, k: b.n / (1 + Math.hypot(b.x / b.n - me.x, b.z / b.n - me.z)) }))
      .sort((p, q) => q.k - p.k).slice(0, 10);
    for (const b of top) for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      const x0 = b.x - dx * 1.1, z0 = b.z - dz * 1.1;
      if (!runClear(x0, z0, o.hw)) continue;
      const pre = Math.hypot(x0 - me.x, z0 - me.z) / o.v + 0.35;
      offer(evalLine(x0, z0, dx, dz, pre, 1));
    }
    // 2b) down the trench lanes, from either end (fuel piles up under the trenches)
    if (o.trench) for (const lz of [LANE_Z, -LANE_Z]) for (const sx2 of [1, -1]) for (const dir of [1, -1]) {
      const x0 = sx2 * (dir === sx2 ? 2.35 : 4.95), z0 = lz, dx = dir * sx2 > 0 ? sx2 : -sx2;
      if (!runClear(x0, z0, o.hw, true)) continue;
      const pre = Math.hypot(x0 - me.x, z0 - me.z) / o.v + 0.5;
      offer(evalLine(x0, z0, dx, 0, pre, 1));
    }
    // 3) the runs the top players made here (a small nudge toward copying them; judged on the fuel there now)
    for (const ln of o.lines || []) {
      const [x0, z0, x1, z1] = ln, len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.5 || !runClear(x0, z0, o.hw)) continue;
      const pre = Math.hypot(x0 - me.x, z0 - me.z) / o.v + 0.35;
      offer(evalLine(x0, z0, (x1 - x0) / len, (z1 - z0) / len, pre, 1.2, 'pro'));
    }
    return best;
  };
  // how the run we're on is doing from where we are now
  const rerateRun = (fuel, me, T, o) => {
    const left = (T.x1 - me.x) * T.dx + (T.z1 - me.z) * T.dz;
    if (left < 0.15) return null;
    const backNow = o.back ? o.back(me.x, me.z) : 0;
    let n = 0;
    for (let i = 0; i < fuel.length; i += 2) {
      const rx = fuel[i] - me.x, rz = fuel[i + 1] - me.z, t = rx * T.dx + rz * T.dz;
      if (t < 0 || t > left + o.reach + 0.1) continue;
      const nearWall = Math.abs(fuel[i]) > FIELD.halfX - 0.3 || Math.abs(fuel[i + 1]) > FIELD.halfZ - 0.3;
      if (Math.abs(rz * T.dx - rx * T.dz) <= o.mouth + 0.09 + (nearWall ? 0.08 : 0)) n += o.weight ? o.weight(fuel[i], fuel[i + 1]) : 1;
    }
    if (n < 1) return null;
    const got = Math.min(n, o.capLeft);
    const ex = me.x + T.dx * left, ez = me.z + T.dz * left;
    if (o.deadline != null && left / o.v + (o.back ? o.back(ex, ez) : 0) + (o.hop + got) / o.fireRate + 0.5 > o.deadline) return null; // won't fit any more
    return got * (T.tag === 'pro' ? 1.2 : 1) / Math.max(0.8, left / o.v + 0.3 + (o.back ? o.back(ex, ez) - backNow : 0));
  };

  // Choose what to collect next. Three kinds of target:
  //   pile  – a clump of fuel on open floor
  //   sweep – a run of fuel lying against our back wall (cleaned with the intake to the wall)
  //   depot – the fuel tray at our wall (entered straight on so the rail doesn't snag us)
  // `anchor` (optional) pulls choices toward a point, e.g. the shooting spot near reload time.
  const pickFuelTarget = (fuel, me, P0, prev, anchor, anchorW, opts = {}) => {
    const P = opts.reach != null ? { ...P0, reach: opts.reach } : P0;
    const a = me.alliance, s = allianceSign(a), wallX = s * FIELD.halfX, inward = -s;
    const toward = -s; // +1 = toward the opponents
    const depot = rectFor('depot', a), tower = rectFor('tower', a);
    const bins = new Map(); const wallZ = []; let depotN = 0, depotZ = 0, towerN = 0, towerZ = 0;
    const towerFace = (inward > 0 ? tower.x1 : tower.x0 - 0) ; // the tower face that points into the field
    const faceDepth = (towerFace - wallX) * inward;
    for (let k = 0; k < fuel.length; k += 2) {
      const x = fuel[k], z = fuel[k + 1];
      if (toward * x > P.reach) continue; // too deep toward the other side
      if (opts.zone) {
        const fd = (x - wallX) * inward; // depth from our wall
        if (opts.zone === 'ours' && fd > ZONE_DEPTH - 0.2) continue;
        if (opts.zone === 'neutral' && fd < ZONE_DEPTH + 0.3) continue;
      }
      if (inRect(depot, x, z, 0.1)) { depotN++; depotZ += z; continue; }
      const dw = (x - wallX) * inward;
      if (z > tower.z0 - 0.25 && z < tower.z1 + 0.25 && dw < faceDepth + 0.8) {
        if (dw > faceDepth - 0.05) { towerN++; towerZ += z; } // piled against the tower's front
        continue; // (fuel under the tower base can't be reached)
      }
      if ((x - wallX) * inward < 0.75) { wallZ.push(z); continue; }
      const key = Math.floor(x / 0.6) * 1000 + Math.floor(z / 0.6);
      const bin = bins.get(key) || { n: 0, x: 0, z: 0 };
      bin.n++; bin.x += x; bin.z += z; bins.set(key, bin);
    }
    const score = (x, z, n, bonus) => {
      const d = Math.hypot(x - me.x, z - me.z);
      let v = (1 + P.density * Math.log1p(n)) * bonus / (d + 1.2) / (1 + MEM.stuck[cellOf(x, z)]);
      if (anchor) v /= 1 + anchorW * Math.hypot(x - anchor.x, z - anchor.z) / 3;
      if (robotNear(x, z, 1.1)) v *= 0.25; // someone is already there
      if (opts.heat) { // the pros picked up a lot of fuel around here
        const nx = a === 'blue' ? x : -x, nz = a === 'blue' ? z : -z;
        const h = opts.heat[Math.round(nx / 0.8) + ',' + Math.round(nz / 0.8)] || 0;
        v *= 1 + 0.8 * (h / (opts.heatMax || 1));
      }
      if (prev && prev.type && Math.hypot(prev.x - x, prev.z - z) < 0.7) v *= 1.25; // stick with a plan
      return v;
    };
    let best = null, bestV = -Infinity;
    const offer = (t, v) => { if (v > bestV) { bestV = v; best = t; } };
    for (const bin of bins.values()) {
      const x = bin.x / bin.n, z = bin.z / bin.n;
      offer({ type: 'pile', x, z, n: bin.n }, score(x, z, bin.n, 1));
    }
    if (opts.pilesOnly) return best; // (auto: no depot, wall or tower runs)
    // back-wall runs: split where there are gaps, or where the tower/depot sit
    wallZ.sort((p, q) => p - q);
    const segs = [];
    for (const z of wallZ) {
      const last = segs[segs.length - 1];
      if (last && z - last.z1 < 0.8) { last.z1 = z; last.n++; } else segs.push({ z0: z, z1: z, n: 1 });
    }
    const zMin = -FIELD.halfZ + 0.5, zMax = FIELD.halfZ - 0.5;
    for (const g of segs) {
      if (g.n < 6) continue; // only worth the trip when a real pile has built up
      const nearStart = Math.abs(me.z - g.z0) < Math.abs(me.z - g.z1);
      let zs = clamp(nearStart ? g.z0 - 0.3 : g.z1 + 0.3, zMin, zMax);
      let ze = clamp(nearStart ? g.z1 + 0.4 : g.z0 - 0.4, zMin, zMax);
      // keep the sweep clear of the tower and the depot, which sit on the same wall
      const dir = Math.sign(ze - zs) || 1;
      for (const r of [tower, depot]) {
        const m = r === tower ? 0.47 : 0.6; // sweep right up to the tower's side
        const lo = r.z0 - m, hi = r.z1 + m;
        if (zs > lo && zs < hi) zs = dir > 0 ? hi : lo;
        if (ze > lo && ze < hi) ze = dir > 0 ? lo : hi;
        if ((zs - lo) * (ze - lo) < 0 || (zs - hi) * (ze - hi) < 0) ze = dir > 0 ? Math.min(ze, lo) : Math.max(ze, hi);
      }
      if ((ze - zs) * dir < 0.3) continue;
      const sx = wallX + inward * 0.95;
      offer({ type: 'sweep', x: sx, z: zs, zEnd: ze, n: g.n, key: Math.round(g.z0 * 2), stopDepth: 0.62 },
        score(sx, zs, g.n, (1 + P.wallBias) * Math.min(1, g.n / 8)));
    }
    if (depotN >= 8 && (B.match ? B.match.depotFails : 0) < 1) { // one bad depot run and we skip it this match
      const cz = depotZ / depotN, sxD = wallX + inward * 1.2;
      offer({ type: 'depot', x: sxD, z: cz, n: depotN, stopDepth: 0.55 }, score(sxD, cz, depotN, 1 + P.wallBias * 0.6));
    }
    if (false && towerN >= 5) { // (no trips into the tower's pocket: robots get wedged there)
      // fuel stacked against the tower front: come in straight, intake to the tower, nudge and back out
      const cz = clamp(towerZ / towerN, tower.z0 + 0.1, tower.z1 - 0.1), sxT = wallX + inward * (faceDepth + 1.1);
      offer({ type: 'tower', x: sxT, z: cz, n: towerN, stopDepth: faceDepth + 0.5 }, score(sxT, cz, towerN, (1 + P.wallBias) * Math.min(1, towerN / 4)));
    }
    return best;
  };

  const shootSpot = (me, P) => {
    const hub = hubOf(me.alliance);
    const back = allianceSign(me.alliance); // direction from hub toward our wall
    const side = (B.match && B.match.side) || 1;
    const baseA = Math.abs(P.shootAngle) < 12 && B.match && B.match.side !== 1 ? 35 : P.shootAngle;
    const angles = [baseA * side, -baseA * side];
    let best = null;
    for (const aDeg of angles) {
      const a = (aDeg * Math.PI) / 180;
      const x = hub.x + back * Math.cos(a) * P.shootDist;
      const z = hub.z + Math.sin(a) * P.shootDist;
      const spot = { x: clamp(x, -FIELD.halfX + 0.6, FIELD.halfX - 0.6), z: clamp(z, -FIELD.halfZ + 0.6, FIELD.halfZ - 0.6) };
      // keep the whole robot inside our alliance zone (outside it the game turns shots into passes)
      const wx = back * FIELD.halfX, maxDepth = ZONE_DEPTH - 0.6;
      if ((spot.x - wx) * -back > maxDepth) spot.x = wx - back * maxDepth;
      let d = Math.hypot(spot.x - me.x, spot.z - me.z) + 2 * MEM.stuck[cellOf(spot.x, spot.z)];
      if (robotNear(spot.x, spot.z, 1.0)) d += 6; // spot taken: use the other one
      if (aDeg !== angles[0]) d += 0.4;           // small preference for the current pattern
      if (!best || d < best.d) best = { ...spot, d };
    }
    return best;
  };

  // ---------------------------------------------------------------------------
  // 6. The driving brain
  // ---------------------------------------------------------------------------
  const B = {
    mode: 'idle', note: '', target: null, path: [], pathAt: 0, targetAt: 0,
    match: null, lastPhase: null, lastPosT: 0, lastPos: null, escapeUntil: 0, escapeDir: null,
    shootStart: 0, shootHop: 0, endHandledAt: 0,
  };

  const startMatch = (view, me) => {
    // old "got stuck here" marks fade, so one bad match (or an old false alarm) doesn't bend our routes for ever
    if (MEM.stuck) for (let c = 0; c < MEM.stuck.length; c++) if (MEM.stuck[c]) MEM.stuck[c] = MEM.stuck[c] < 0.3 ? 0 : MEM.stuck[c] * 0.6;
    const cfg0 = findRobotConfig(me.team);
    const pick = pickParams({ multiplayer: B.multiplayer, slot: modeKey(), team: me.team, blocker: !!(cfg0 && cfg0.blocker) });
    B.match = {
      P: pick.p, replay: pick.replay, changed: pick.changed, trial: pick.trial || null,
      alliance: me.alliance, team: me.team,
      phaseStart: {}, phaseGain: {}, lastFuelPts: 0, lastInactive: 0,
      stuckEvents: 0, wasted: 0, depotFails: 0, robotBlocks: 0, foulsGiven: 0, pinnedEvents: 0, pinsReleased: 0, oppOffPts: 0, oppTelePts: 0, multiplayer: !!B.multiplayer,
      slotKey: modeKey(), defenseOnly: !!(B.multiplayer && (SETTINGS.defenseOnly || SETTINGS.bumpOnly)),
      bumpOnly: !!(B.multiplayer && SETTINGS.bumpOnly), side: Math.random() < 0.5 ? 1 : -1, started: Date.now(),
    };
    B.path = []; B.target = null; B.task = null; B.jam = 0; B.defTarget = null; B.autoSwipes = 0; B.autoNeedShoot = false;
    if (MEM.effCap && MEM.effCap[me.team]) MEM.effCap[me.team] += 2;
    B.cycleStart = performance.now(); B.hadFuel = false; B.topOffWorth = true; B.autoVolleys = 0; B.fin = null; B.lidBase = null; B.lidCmd = null;
  };

  const fuelPoints = (sc) => (sc.autoFuel || 0) + (sc.teleFuel || 0);

  const trackScore = (view, robot) => {
    const m = B.match; if (!m || !robot) return;
    m.alliance = robot.alliance; // always our own alliance, never another team's
    const sc = view.score && view.score[m.alliance]; if (!sc) return;
    // Alone on our alliance (singleplayer): the alliance's fuel points are ours.
    // With teammates: use our robot's own fuel count so their scoring isn't credited to us.
    const mates = view.robots.some((r) => r !== robot && r.alliance === robot.alliance);
    const drv = (view.drivers || []).find((d) => d.robot === robot.id);
    const source = mates && drv ? 'own' : 'alliance';
    const pts = source === 'own' ? (drv.fuel || 0) : fuelPoints(sc);
    if (m.ptsSource !== source) { m.ptsSource = source; m.lastFuelPts = pts; }
    const ph = view.phase;
    // fuel still lands after auto (the gap) and after the buzzer (settle): count it toward auto / endgame
    const bucket = ph === 'gap' ? 'auto' : (ph === 'settle' || ph === 'done' || ph === 'post') ? 'endgame' : ph;
    if (PLAY_PHASES.includes(bucket) && m.lastFuelPts != null) {
      m.phaseGain[bucket] = (m.phaseGain[bucket] || 0) + Math.max(0, pts - m.lastFuelPts);
    }
    m.lastFuelPts = pts;
    if (typeof sc.total === 'number') m.lastTotal = sc.total; // the scoreboard number
    const oppA = m.alliance === 'blue' ? 'red' : 'blue', osc = view.score[oppA];
    if (osc) {
      const fouls = osc.foulPoints || 0;
      if (m.lastOppFouls != null && fouls > m.lastOppFouls) {
        m.foulsGiven += fouls - m.lastOppFouls;
        B.note = 'Mistake: we drew a foul — easing off defense';
        B.defPauseUntil = performance.now() + 4000;
        B.foulPending = true; // tick records who/where so we stay away from them
      }
      m.lastOppFouls = fouls;
      const op = fuelPoints(osc);
      const ourOff = !(view.hubs && view.hubs[m.alliance] && view.hubs[m.alliance].active);
      if (m.lastOppPts != null && op > m.lastOppPts && ourOff && SHIFT_PHASES.includes(ph)) m.oppOffPts += op - m.lastOppPts;
      if (m.lastOppPts != null && op > m.lastOppPts && SHIFT_PHASES.includes(ph)) m.oppTelePts += op - m.lastOppPts;
      m.lastOppPts = op;
    }
    const inact = sc.inactiveFuel || 0;
    if (inact > m.lastInactive) { m.wasted += inact - m.lastInactive; B.note = 'Mistake: shot into an inactive hub'; }
    m.lastInactive = inact;
  };

  const finishMatch = () => {
    const m = B.match; if (!m) return;
    const g = m.phaseGain;
    const shiftPts = SHIFT_PHASES.reduce((a, ph) => a + (g[ph] || 0), 0);
    // defense counts in multiplayer: fewer opponent points while their hub is on, and no fouls
    // Singleplayer: judged by the game's actual final score. Multiplayer: our own fuel (teammates' doesn't count),
    // plus defense terms; defense only: how few points the opponents got.
    const actual = typeof m.lastTotal === 'number' ? m.lastTotal : shiftPts + (g.auto || 0);
    const reward = m.defenseOnly
      ? 300 - 1.0 * m.oppTelePts - 1.5 * m.foulsGiven - 0.5 * m.stuckEvents
      : !m.multiplayer ? actual
        : shiftPts + 0.5 * (g.auto || 0) - 1.0 * m.wasted - 1.5 * m.stuckEvents - 1.0 * m.foulsGiven - 0.3 * m.oppOffPts;
    // personal best (per robot and mode): save the replay
    const myScore = m.multiplayer ? shiftPts + (g.auto || 0) : actual;
    const pbKey = `${m.team}:${m.slotKey}`;
    MEM.pb = MEM.pb || {};
    const newPB = !m.defenseOnly && myScore > (MEM.pb[pbKey] || 0);
    if (newPB) {
      const old = MEM.pb[pbKey] || 0;
      MEM.pb[pbKey] = myScore;
      if (old > 0 && !m.pbChecked) { B.saveReplay = { until: performance.now() + 20000, score: myScore, tries: 0 }; }
      if (old > 0) B.note = `New personal best: ${Math.round(myScore)} — press 🏆 to post it to GitHub`;
    }
    // update this robot's own strategy, then its archetype's (so similar robots start from what works)
    const learnInto = (LS) => {
      if (m.replicate) return false; // a 1:1 replay of a pro's match isn't our plan: learn nothing from it
      const best = LS.best; let acc = false;
      if (m.trial && LS.trial) {
        // replay lesson on trial: keep it if it did about as well as (or better than) what we had
        if (best.avg === null || reward >= best.avg * 0.97) { best.p = { ...m.P }; best.avg = best.avg === null ? reward : (reward + best.avg) / 2; best.n = 1; acc = true; }
        delete LS.trial;
        return acc;
      }
      if (best.avg === null) {
        best.avg = reward; best.n = 1; best.p = { ...m.P }; acc = true;
      } else if (m.replay) {
        best.n++; best.avg += (reward - best.avg) / Math.min(best.n, 5);
      } else if (reward > best.avg) {
        // the slightly-new idea scored more: keep it
        best.p = { ...m.P }; best.avg = (reward + best.avg) / 2; best.n = 1; acc = true;
        for (const k of m.changed) LS.sigma[k] = Math.min(LS.sigma[k] * 1.25, (PARAMS[k].max - PARAMS[k].min) * 0.3);
      } else {
        for (const k of m.changed) LS.sigma[k] = Math.max(LS.sigma[k] * 0.93, (PARAMS[k].max - PARAMS[k].min) * 0.03);
      }
      return acc;
    };
    const accepted = learnInto(robotSlot(m.slotKey, m.team));
    learnInto(archSlot(m.slotKey, m.team));
    MEM.matches++;
    MEM.history.push({
      t: Date.now(), reward: Math.round(reward * 10) / 10, shiftPts, auto: g.auto || 0, score: myScore,
      perShift: SHIFT_PHASES.map((ph) => g[ph] || 0), wasted: m.wasted, stuck: m.stuckEvents,
      bump: m.bumpOnly, arch: archOf(m.team), fouls: m.foulsGiven, pinned: m.pinnedEvents, pinsReleased: m.pinsReleased, oppOff: m.oppOffPts, oppTele: m.oppTelePts, mp: m.multiplayer, def: m.defenseOnly,
      accepted, replay: m.replay, team: m.team,
    });
    if (MEM.history.length > 200) MEM.history.splice(0, MEM.history.length - 200);
    // slowly forget old stuck spots so the bot retries them later
    for (let i = 0; i < MEM.stuck.length; i++) MEM.stuck[i] *= 0.9;
    saveMem();
    // "best match" means the highest score ever (per robot and mode); the plan's average is a different number
    const pbText = newPB ? ' — new best match!' : '';
    B.note = m.replicate ? `Match ${MEM.matches}: ${reward.toFixed(0)} pts replaying ${m.replicate}'s run 1:1${pbText} (the bot's own plan is unchanged)` : m.trial ? `Match ${MEM.matches}: ${reward.toFixed(0)} pts with the strategy from ${m.trial}${pbText} — ${accepted ? 'keeping it' : 'not better, went back'}` :
      accepted ? `Match ${MEM.matches}: ${reward.toFixed(0)} pts${pbText} — beat the plan’s average, keeping the changes` :
      `Match ${MEM.matches}: ${reward.toFixed(0)} pts${pbText}${m.replay ? ' (checking the current plan)' : ' — below the plan’s average, undoing the changes'}`;
    B.match = null;
  };

  const ourHubTiming = (view, me) => {
    const active = !!(view.hubs && view.hubs[me.alliance] && view.hubs[me.alliance].active);
    const ph = view.phase, clk = view.clock || 0;
    let untilActive = active ? 0 : Infinity, untilInactive = active ? Infinity : 0;
    if (/^shift[1-4]$/.test(ph)) {
      if (active) untilInactive = ph === 'shift4' ? Infinity : clk;
      else untilActive = clk;
    } else if (ph === 'transition' && !active) untilActive = clk;
    return { active, untilActive, untilInactive };
  };

  const drive = (vx, vz, wantYaw, yaw, sx) => {
    // In or near a trench: intake out and down (stowed intakes swing UP and catch on the trench roof),
    // blocker down too. This runs on every move, so no other behaviour can raise them in there.
    if (B.nearTrenchNow) {
      sendKey('KeyE', false); sendKey('ShiftLeft', true);
      if (B.blockerUp) tapKey('KeyX', performance.now());
    }
    // field direction -> driver keys (W = toward the opponents from your station)
    axis('fwd', vx * sx, 'KeyW', 'KeyS');
    axis('side', vz * sx, 'KeyD', 'KeyA');
    if (wantYaw === null || B.inTrench) { axis('rot', 0, 'KeyJ', 'KeyL'); return 0; } // no turning in a trench
    const err = wrap(wantYaw - yaw);
    B.yawErr = err; B.yawWant = wantYaw;
    // The game ramps the turn speed up while a turn key is held and drops it to zero when it's let go, and the
    // robot then coasts ~35° from full speed. So: hold the key for big turns, let go early enough to coast onto
    // the heading (allowing for the time until our next update), and tap for small corrections.
    const toward = Math.sign(err) * (B.yawRate || 0); // > 0: already turning the right way (rad/s)
    const coast = toward > 0 ? toward * (0.13 + (B.tickDt || 0.016)) + 0.02 : 0;
    const ae = Math.abs(err);
    const cmd = ae < 0.035 || ae <= coast ? 0 : ae > 0.35 ? Math.sign(err) : Math.sign(err) * clamp(ae / 0.35, 0.3, 1);
    // J turns counter-clockwise (+yaw). Part-way turns are timed pulses at least a couple of game frames long
    // (a press shorter than a frame can be missed, and every release resets the game's turn ramp).
    pwm.rot = 0;
    let on = cmd !== 0;
    if (on && Math.abs(cmd) < 0.999) { const per = Math.max(100, 2.2 * (B.tickDt || 0.016) * 1000); on = ((performance.now() % per) / per) < Math.abs(cmd); }
    sendKey('KeyJ', on && cmd > 0); sendKey('KeyL', on && cmd < 0);
    return err;
  };

  // Trenches: line up with the middle of the lane before the mouth (that clears the posts), then drive
  // straight through with no steering and no turning until we come out the other end.
  const LANE_Z = 3.40;
  const trenchAdjust = (me, goal, r) => {
    const ax = Math.abs(me.x), az = Math.abs(me.z);
    const through = inTrench(me.x, me.z) || (!B.noTrench && (B.path || []).slice(0, 4).some((p) => inTrench(p.x, p.z)));
    if (!through) return r;
    const dirX = Math.sign(goal.x - me.x) || Math.sign(r.vx) || 1;
    if (ax > 3.0 && ax < 4.3 && az > 2.76) {
      B.inTrench = true;
      // if we stop moving in here, something's in the way (a trench arm, a robot): back out the other end,
      // and remember that this way through doesn't work for us
      const t = performance.now(), spd = Math.hypot(me.vx || 0, me.vz || 0);
      if (spd < 0.15 && t > (B.trenchFlipUntil || 0)) { B.trenchStall = B.trenchStall || t; } else B.trenchStall = 0;
      if (B.trenchStall && t - B.trenchStall > 900) {
        B.trenchFlipUntil = t + 2500; B.trenchStall = 0; B.path = [];
        MEM.stuck[cellOf(me.x + dirX * 0.6, me.z)] += 2; MEM.stuck[cellOf(me.x, me.z)] += 1;
        B.note = 'Mistake: stuck in the trench — backing out the other side';
      }
      const d = t < (B.trenchFlipUntil || 0) ? -dirX : dirX;
      return { vx: d, vz: 0, dGoal: r.dGoal };
    }
    if (az > 2.0 && ax > 1.6 && ax < 5.6) {
      // line up with the middle of the lane while still rolling toward it
      const ez = Math.sign(me.z || 1) * LANE_Z - me.z;
      const lined = Math.abs(ez) < 0.15;
      const nearMouth = ax > 2.6 && ax < 4.7;
      return { vx: dirX * (lined ? 0.9 : nearMouth ? 0.3 : 0.6), vz: clamp(ez * 3, -0.9, 0.9), dGoal: r.dGoal };
    }
    return r;
  };
  const followTo = (now, me, goal, P, finalSlow) => trenchAdjust(me, goal, followToRaw(now, me, goal, P, finalSlow));
  const followToRaw = (now, me, goal, P, finalSlow) => {
    // committed to a trench route: don't keep re-deciding between the trench and the bump (that stalls us at the mouth)
    const viaTrench = B.path.length && Math.abs(me.z) > 1.8 && B.path.slice(0, 6).some((p) => inTrench(p.x, p.z));
    const every = viaTrench ? 1600 : OTHERS.length ? 300 : 600;
    if (!B.path.length || now - B.pathAt > every || !B.goal || Math.hypot(B.goal.x - goal.x, B.goal.z - goal.z) > (viaTrench ? 0.9 : 0.3)) {
      B.path = planPath(me, goal); B.pathAt = now; B.goal = goal;
    }
    while (B.path.length > 1 && Math.hypot(B.path[0].x - me.x, B.path[0].z - me.z) < 0.55) B.path.shift();
    const wp = B.path[0] || goal;
    const dx = wp.x - me.x, dz = wp.z - me.z, d = Math.hypot(dx, dz) || 1e-6;
    const dGoal = Math.hypot(goal.x - me.x, goal.z - me.z);
    if (!finalSlow) return { vx: dx / d, vz: dz / d, dGoal };
    // Arrive without overshooting: the speed we may carry is what we can still brake from
    // (v = sqrt(2·a·d)); if we're coming in faster than that, push back against the motion.
    const vmax = Math.max(3, B.vmax || 4);
    const brakeA = 3.2 * (0.8 / P.slowRadius);
    const vDes = Math.min(vmax, Math.sqrt(2 * brakeA * Math.max(0, dGoal - 0.08)));
    const gx = goal.x - me.x, gz = goal.z - me.z, gd = Math.hypot(gx, gz) || 1;
    const vAlong = ((me.vx || 0) * gx + (me.vz || 0) * gz) / gd;
    if (vAlong > vDes + 0.35) {
      const k = clamp((vAlong - vDes) / vmax * 1.6, 0.15, 1);
      return { vx: -(gx / gd) * k, vz: -(gz / gd) * k, dGoal };
    }
    // also damp sideways drift near the goal
    const side = dGoal < 1.5 ? 0.5 : 0;
    const vPerpX = (me.vx || 0) - vAlong * gx / gd, vPerpZ = (me.vz || 0) - vAlong * gz / gd;
    const mag = dGoal < 0.12 ? 0 : clamp(vDes / vmax, 0.12, 1);
    return { vx: (dx / d) * mag - (vPerpX / vmax) * side, vz: (dz / d) * mag - (vPerpZ / vmax) * side, dGoal };
  };

  // Our robot: the one the game marks as local, or by the game's own id for us. Only in
  // singleplayer (one robot on the field) is it safe to fall back to the first robot.
  const myRobot = (game, view) => {
    const R = view && view.robots; if (!R || !R.length) return null;
    return R.find((r) => r.local) || (game && game.localId != null ? R.find((r) => r.id === game.localId) : null) ||
      (R.length === 1 && !B.multiplayer ? R[0] : null);
  };

  const tick = () => {
    const now = performance.now();
    if (B.note !== B.prevNote) { B.prevNote = B.note; B.noteAt = now; }
    else if (B.note && now - B.noteAt > 6000 && !/^Match/.test(B.note)) B.note = '';
    releaseTaps(now);
    sniffRoom(now);
    B.inTrench = false;
    if (!SETTINGS.enabled) { if (held.size) releaseAll(); B.mode = 'off'; return; }
    if (B.ranked) { if (held.size) releaseAll(); B.mode = 'off in ranked'; return; }
    const game = findGame();
    const view = game && game.view;
    if (!view || !view.robots) {
      if (B.match && B.lastPhase === 'settle') finishMatch(); // went straight to the results screen
      releaseAll(); B.mode = game ? 'waiting for a match' : 'looking for the game'; tryMenus(); return;
    }
    const robot = myRobot(game, view);
    if (!robot) { releaseAll(); B.mode = 'waiting for a match'; return; }

    const ph = view.phase;
    if (ph !== B.lastPhase) {
      if ((ph === 'countdown' || ph === 'pre') && B.match && B.lastPhase === 'settle') finishMatch();
      if ((ph === 'countdown' || ph === 'pre' || ph === 'auto') && !B.match) startMatch(view, robot);
      if ((ph === 'done' || ph === 'post') && B.match) { trackScore(view, robot); finishMatch(); }
      B.lastPhase = ph;
    }
    if (!B.match && PLAY_PHASES.includes(ph)) startMatch(view, robot);
    trackScore(view, robot);

    // Right after the buzzer (settle) the match is still on screen, so its pause menu can still save the
    // replay: if this is a new personal best, save it now (the results screen has no "Save replay").
    if (ph === 'settle' && B.match && !B.match.pbChecked) {
      const m = B.match;
      const cur = m.multiplayer ? Object.values(m.phaseGain).reduce((a, b2) => a + b2, 0) : (m.lastTotal || 0);
      const old = (MEM.pb || {})[`${m.team}:${m.slotKey}`] || 0;
      if (!m.defenseOnly && old > 0 && cur > old && !B.saveReplay) B.saveReplay = { until: now + 12000, score: cur, tries: 0 };
      m.pbChecked = true;
    }
    if (!PLAY_PHASES.includes(ph)) { releaseAll(); B.mode = ph || 'menu'; tryMenus(); return; }

    OTHERS = view.robots.filter((o) => o !== robot).map((o) => ({
      x: o.pos[0], z: o.pos[2], vx: (o.vel && o.vel[0]) || 0, vz: (o.vel && o.vel[2]) || 0, foe: o.alliance !== robot.alliance,
    }));
    B.robotsSeen = OTHERS.length;
    const P = B.match.P;
    const cfg = findRobotConfig(robot.team);
    const mouthSign = cfg && cfg.intake.mouth && cfg.intake.mouth.centre[0] > 0 ? 1 : -1;
    const br = (cfg && cfg.brain) || {};
    const info = {
      minR: br.minRange || 1.4, maxR: br.maxRange || 5.5,
      turret: !!(cfg && cfg.shooter && cfg.shooter.turret),
      maxShotSpeed: br.maxShotSpeed || 0, maxPassSpeed: br.maxPassSpeed || 0,
      agitates: !!(br.agitate || (cfg && cfg.hopper && cfg.hopper.slide && cfg.hopper.slide.squeeze && cfg.hopper.slide.squeeze.agitate)),
      blocker: !!(cfg && cfg.blocker),
    };
    info.moveShoot = info.turret && info.maxShotSpeed >= 2;
    // which end of the robot the shooter faces (the game turns that end to the hub when we press score)
    info.shooterSign = cfg && cfg.shooter && Math.abs(Math.abs(cfg.shooter.yawDeg || 0) - 180) < 45 ? -1 : 1;
    info.mouthHalf = (cfg && cfg.intake && cfg.intake.mouth && cfg.intake.mouth.half && cfg.intake.mouth.half[2]) || 0.3;
    info.mouthReach = Math.abs((cfg && cfg.intake && cfg.intake.mouth && cfg.intake.mouth.centre && cfg.intake.mouth.centre[0]) || 0.5);
    // Expandable hoppers: the game's "Robot special" key raises a lid so the hopper holds more (1678 today; the list
    // comes from the game's own control hint). Dumpers: robots that shoot from right up close, or whose hopper lifts
    // to dump on its own (5460 is a dumper with a turret).
    info.lidX = hasLid(cfg, robot.team);
    info.dumper = DUMPER_TEAMS.has(robot.team) || info.minR <= 1.0;
    // Turrets that can't spin all the way round (971, 118, 5460): the chassis has to point the turret's swing at the target
    const tRange = cfg && cfg.shooter && cfg.shooter.turret && cfg.shooter.turret.range;
    info.turretHalfArc = info.turret && tRange && tRange[0] != null && tRange[1] != null && tRange[1] - tRange[0] < 2 * Math.PI - 0.1 ? (tRange[1] - tRange[0]) / 2 : null;
    info.turretMid = info.turretHalfArc != null ? (tRange[0] + tRange[1]) / 2 : 0;
    info.halfW = (cfg && cfg.bumper && cfg.bumper.width ? cfg.bumper.width / 2 : 0.45);
    // the in/out wiggle only helps swinging-arm intakes and hoppers that squeeze (not plain drawers like 1323's)
    const slide = cfg && cfg.hopper && cfg.hopper.slide;
    info.canWiggle = !!(cfg && cfg.intake && cfg.intake.arm) || !!(slide && slide.squeeze);
    B.tallMe = robotTop(robot.team) > TRENCH_CLEAR - 0.005;
    B.info = info;
    const me = { x: robot.pos[0], z: robot.pos[2], vx: robot.vel[0], vz: robot.vel[2], alliance: robot.alliance, team: robot.team };
    const yaw = yawOf(robot.quat);
    // how fast we're turning (and how often we get to act): the turn control needs both
    // (measured per game frame: on a slow computer the game draws fewer frames than we tick)
    if (B.yawT == null || yaw !== B.prevYaw || robot.pos[0] !== B.prevPx) {
      const dtT = B.yawT ? clamp((now - B.yawT) / 1000, 0.005, 0.4) : 0.016;
      B.yawRate = B.yawT ? wrap(yaw - B.prevYaw) / dtT : 0;
      B.tickDt = B.tickDt ? B.tickDt * 0.8 + dtT * 0.2 : dtT; // time between game frames
      B.prevYaw = yaw; B.prevPx = robot.pos[0]; B.yawT = now;
    }
    const speed = Math.hypot(robot.vel[0], robot.vel[2]);
    B.vmax = Math.max((B.vmax || 3.5) * 0.9995, speed); // this robot's top speed, learned as it drives
    B.nearTrenchNow = Math.abs(me.z) > 2.6 && Math.abs(me.x) > 2.3 && Math.abs(me.x) < 5.0; // in or right by a trench
    B.blockerUp = robot.state === 'BLOCKING';
    const sx = robot.alliance === 'blue' ? 1 : -1;
    // What the hopper really holds: some fill up before their listed capacity (5460 tops out in the high 30s).
    // Learned per robot: lowered when the intake stops taking fuel, raised whenever it holds more.
    const capRaw = robot.hopperCapacity || 40;
    MEM.effCap = MEM.effCap || {};
    if ((robot.hopperFuel || 0) >= (MEM.effCap[robot.team] || capRaw)) MEM.effCap[robot.team] = Math.min(capRaw, (robot.hopperFuel || 0) + 1);
    const cap = Math.min(capRaw, MEM.effCap[robot.team] || capRaw);
    const rawHop = robot.hopperFuel || 0;
    // Fuel counting: the game's own hopper count, minus fuel we found jammed on the last volley
    // (that fuel is tried again on the next volley), and "full" also when the intake stops gaining.
    if (rawHop > (B.lastRaw || 0)) B.hopRiseAt = now;
    B.lastRaw = rawHop;
    if (rawHop < (B.jam || 0)) B.jam = rawHop;
    const hop = Math.max(0, rawHop - (B.jam || 0));
    const intakeStalled = B.mode === 'collecting' && rawHop >= cap * 0.7 && now - (B.hopRiseAt || now) > 3000;
    const full = rawHop >= cap * 0.95 || intakeStalled;
    B.fuel = { raw: rawHop, usable: hop, cap, jam: B.jam || 0, full };
    // Route over the bumps instead of the trenches when we won't fit: robots that are too tall, and
    // net-topped hoppers once they're well filled (hard-topped ones like 2910 still fit when full).
    const wasNoTrench = B.noTrench;
    // expandable hopper: is the lid up? (its height compared with where it sat at the start of the match)
    // (Fuel also bulges the lid a little on its own; only "most of the way to its full height" counts as raised.)
    B.lidUp = false; B.lidTall = false;
    if (info.lidX && robot.net && robot.net.length) {
      let mx = -1e9; for (let i = 1; i < robot.net.length; i++) if (robot.net[i] > mx) mx = robot.net[i];
      B.lidBase = B.lidBase == null ? mx : Math.min(B.lidBase, mx);
      const netMax = (cfg && cfg.hopper && cfg.hopper.net && cfg.hopper.net.max) || B.lidBase + 0.2;
      const measuredUp = mx > B.lidBase + 0.6 * (netMax - B.lidBase);
      if (B.lidCmd == null) B.lidCmd = false; // every match starts with the lid down
      // the game lowered it by itself (some robots do after a volley): follow that
      if (B.lidCmd && !measuredUp && rawHop < cap * 0.3) { B.lidDownSince = B.lidDownSince || now; if (now - B.lidDownSince > 3000) B.lidCmd = false; }
      else B.lidDownSince = 0;
      B.lidUp = B.lidCmd || measuredUp;
      B.lidTall = mx > TRENCH_CLEAR - 0.01; // any part of it above the trench roof
    }
    B.noTrench = !fitsTrench(robot.team, rawHop / Math.max(1, cap)) || B.lidUp || B.lidTall; // lid up: it won't go under a trench
    // Lid control. X toggles the lid, so remember which way we last asked for and only press when we want the other
    // way (pressing again while it's still moving would just flip the request back). The game also lowers it by itself
    // after a volley, and a full hopper can hold it up until there's room: re-sync with what it really is when it's
    // stayed that way a while.
    const setLid = (up) => {
      if (!info.lidX) return;
      if (up !== B.lidCmd && now - (B.lidTapAt || 0) > 600) { tapKey('KeyX', now); B.lidTapAt = now; B.lidCmd = up; }
    };
    // A turret that can't spin all the way round: the chassis heading that puts (tx, tz) in the middle of its swing,
    // or null when the target is already comfortably inside the swing (then the turret does the aiming).
    const turretChassisYaw = (tx, tz) => {
      if (info.turretHalfArc == null) return null;
      const want = wrap(yawToFace(tx - me.x, tz - me.z, info.shooterSign) - info.turretMid);
      return Math.abs(wrap(want - yaw)) > Math.max(0.08, info.turretHalfArc - 0.25) ? want : null;
    };
    if (B.noTrench !== wasNoTrench) B.path = []; // re-plan with the new rule
    const timing = ourHubTiming(view, robot);

    // --- getting unstuck (learn from mistakes) ---
    if (now < B.escapeUntil) {
      sendKey('Space', false);
      drive(B.escapeDir.x, B.escapeDir.z, null, yaw, sx);
      B.mode = 'unsticking';
      return;
    }
    // --- being pinned: an opponent holding us against a wall or field element ---
    if (now < (B.pinEscapeUntil || 0)) {
      sendKey('Space', false); sendKey('ShiftLeft', false);
      drive(B.pinEscapeDir.x, B.pinEscapeDir.z, null, yaw, sx);
      B.mode = 'escaping pin';
      B.lastPos = { x: me.x, z: me.z }; B.lastPosT = now; // a pin isn't a bad spot on the field
      return;
    }
    const pushingOnPurpose = /^(shoving|containing|pushing back|blocking shots|defending|bump defense|guarding bump|guarding trench)$/.test(B.mode || '');
    const firingFine = B.mode === 'shooting' && now - (B.shotProgress || 0) < 1200;
    let pinner = null;
    if (!pushingOnPurpose && !firingFine && speed < 0.25) {
      for (const o of view.robots) {
        if (o === robot || o.alliance === robot.alliance) continue;
        const ox = o.pos[0], oz = o.pos[2];
        if (Math.hypot(ox - me.x, oz - me.z) < 1.05 && againstSolid(me.x, me.z, me.x - ox, me.z - oz)) { pinner = o; break; }
      }
    }
    if (pinner) {
      if (!B.pinnedSince) B.pinnedSince = now;
      if (now - B.pinnedSince > 700) {
        // slide out along the wall (sideways to the pinner), toward open field; alternate sides if it fails
        const ax = me.x - pinner.pos[0], az = me.z - pinner.pos[2], n = Math.hypot(ax, az) || 1;
        let tx = -az / n, tz = ax / n;
        let useA = !againstSolid(me.x, me.z, tx, tz) && (againstSolid(me.x, me.z, -tx, -tz) || -(me.x * tx + me.z * tz) >= 0);
        if ((B.pinTries || 0) % 2 === 1) useA = !useA;
        if (!useA) { tx = -tx; tz = -tz; }
        B.pinEscapeDir = { x: tx, z: tz };
        B.pinEscapeUntil = now + 800;
        B.pinTries = (B.pinTries || 0) + 1;
        B.pinnedSince = 0;
        if (B.match) B.match.pinnedEvents++;
        B.note = `Pinned by ${pinner.team} — sliding out`;
        B.path = []; B.task = null;
      }
    } else {
      B.pinnedSince = 0;
      if (now - (B.pinEscapeUntil || 0) > 3000) B.pinTries = 0;
    }
    // only call it stuck if we've been trying to drive for the whole window (not just pulling away after a volley)
    if (B.wantMove && !/^(shooting|waiting for hub|gap)$/.test(B.mode || '')) { if (!B.moveSince) B.moveSince = now; } else B.moveSince = 0;
    if (!B.lastPos || now - B.lastPosT > 900) {
      const wantedMove = B.wantMove && B.mode !== 'shooting' && !B.nearGoal && B.moveSince && now - B.moveSince > 1300;
      if (B.lastPos && wantedMove && Math.hypot(me.x - B.lastPos.x, me.z - B.lastPos.z) < 0.12) {
        if (robotNear(me.x, me.z, 1.3)) {
          // a robot is in the way: that isn't a bad spot on the field, so change the pattern instead
          B.match.robotBlocks++;
          B.match.side = -(B.match.side || 1);
          B.note = 'Robot in the way — switching sides';
        } else {
          MEM.stuck[cellOf(me.x, me.z)] += 1;
          if (B.lastCmd) MEM.stuck[cellOf(me.x + B.lastCmd.x * 0.5, me.z + B.lastCmd.z * 0.5)] += 1;
          B.match.stuckEvents++;
          B.note = 'Mistake: got stuck — remembering this spot';
        }
        const back = B.lastCmd ? { x: -B.lastCmd.x, z: -B.lastCmd.z } : { x: -sx, z: 0 };
        const side = Math.random() < 0.5 ? 1 : -1;
        B.escapeDir = { x: back.x * 0.7 - back.z * 0.7 * side, z: back.z * 0.7 + back.x * 0.7 * side };
        B.escapeUntil = now + 550;
        B.path = []; B.target = null; B.task = null;
      }
      B.lastPos = { x: me.x, z: me.z }; B.lastPosT = now;
    }

    // --- decide what to do ---
    const hub = hubOf(robot.alliance);
    const s = allianceSign(robot.alliance), wallX = s * FIELD.halfX, inward = -s;
    const depth = (me.x - wallX) * inward; // metres from our wall
    const PS = { ...P, shootDist: clamp(P.shootDist, info.minR + 0.3, info.maxR - 0.6) }; // fit this robot's range
    // where we may pass from: the neutral zone. Chassis-aimed robots also keep out of the hub's shadow;
    // turrets aim themselves. Once a pass has started, small drifts don't cancel it (no back-and-forth).
    const midPass = B.mode === 'passing';
    const canPass = depth > ZONE_DEPTH + (midPass ? 0.25 : 0.45) && depth < 2 * FIELD.halfX - ZONE_DEPTH - 0.45 &&
      (info.turret || Math.abs(me.z) > (midPass ? 0.7 : 1.2)) && now > (B.passMoveUntil || 0);
    // dumpers only make the trip with a full hopper (90%+); everyone else uses what they've learned (and the top-off
    // rule below). The deadlines further down are exceptions for both.
    const minLoad = Math.max(1, Math.round((info.dumper ? Math.max(P.minLoadFrac, 0.9) : P.minLoadFrac) * cap));
    // "Copy the pros": what we learned from top replays for this robot (blue-side coordinates)
    const pro = MEM.copy ? MEM.copy[robot.team] : null;
    const W = (q) => (robot.alliance === 'blue' ? { x: q[0], z: q[1] } : { x: -q[0], z: -q[1] });
    let spotNow = shootSpot(me, PS);
    // Coming in from the neutral zone: shoot from just inside our zone, right where we cross in (behind the
    // bump, or at the trench exit), the way the top players do, instead of driving deep into the zone.
    if (!info.turret && view.phase !== 'auto') {
      let ez = clamp(me.z, -FIELD.halfZ + info.halfW + 0.12, FIELD.halfZ - info.halfW - 0.12);
      if (Math.abs(ez) < 1.25) ez = (ez >= 0 ? 1 : -1) * 1.8; // the hub is in the way: the bump beside it
      const q = { x: wallX + inward * (ZONE_DEPTH - 0.62), z: ez };
      const dq = Math.hypot(q.x - hub.x, q.z - hub.z), dIn = Math.hypot(q.x - me.x, q.z - me.z);
      if (dq > info.minR + 0.3 && dq < info.maxR - 0.6 && !robotNear(q.x, q.z, 1.0) && dIn < spotNow.d - 0.3) spotNow = { ...q, d: dIn };
    }
    if (pro && pro.shots && pro.shots.length && view.phase !== 'auto') {
      // shoot from the nearest spot the pros shot from (inside our zone and in our range)
      let bestQ = null, bd = Infinity;
      for (const q of pro.shots) {
        const w = W(q), dh = Math.hypot(w.x - hub.x, w.z - hub.z), dw = (w.x - wallX) * inward;
        if (dw > ZONE_DEPTH - 0.6 || dh < info.minR + 0.3 || dh > info.maxR - 0.6) continue;
        const d = Math.hypot(w.x - me.x, w.z - me.z);
        if (d < bd) { bd = d; bestQ = w; }
      }
      if (bestQ && bd < spotNow.d + 0.6) spotNow = { ...bestQ, d: bd }; // their spot, unless it's well out of our way
    } else if (info.turret && view.phase !== 'auto') {
      // a turret aims itself: the nearest point inside our zone that's in range will do
      const maxDepth = ZONE_DEPTH - 0.6;
      let qx = (me.x - wallX) * inward > maxDepth ? wallX + inward * maxDepth : me.x;
      let qz = clamp(me.z, -FIELD.halfZ + 0.6, FIELD.halfZ - 0.6);
      let dx = qx - hub.x, dz = qz - hub.z, dd = Math.hypot(dx, dz) || 1;
      const rWant = clamp(dd, info.minR + 0.4, info.maxR - 0.7);
      qx = hub.x + (dx / dd) * rWant; qz = hub.z + (dz / dd) * rWant;
      if ((qx - wallX) * inward > maxDepth) qx = wallX + inward * maxDepth; // keep it inside the zone
      spotNow = { x: qx, z: qz, d: Math.hypot(qx - me.x, qz - me.z) };
    }
    if (view.phase === 'auto') {
      // quickest cycle: just inside our zone, beside the hub, on the side we're coming from
      const side = me.z >= 0 ? 1 : -1;
      const q = { x: hub.x + s * 1.2, z: side * 1.9 }; // fully inside our zone, right behind the bump
      const dq = Math.hypot(q.x - hub.x, q.z - hub.z);
      if (dq > info.minR + 0.3 && dq < info.maxR - 0.6) spotNow = { ...q, d: Math.hypot(q.x - me.x, q.z - me.z) };
    }
    // on the way in, don't keep swapping between two spots (that's how robots end up wiggling at the bump)
    if (!info.turret && B.mode === 'to-hub' && B.lastSpot && Math.hypot(B.lastSpot.x - spotNow.x, B.lastSpot.z - spotNow.z) > 0.5) {
      const dl = Math.hypot(B.lastSpot.x - me.x, B.lastSpot.z - me.z);
      if (dl < spotNow.d + 0.8 && !robotNear(B.lastSpot.x, B.lastSpot.z, 1.0)) spotNow = { x: B.lastSpot.x, z: B.lastSpot.z, d: dl };
    }
    B.lastSpot = { x: spotNow.x, z: spotNow.z };
    B.spot = spotNow;
    // How long the drive to our shooting spot takes from here: route length (straight line plus a bit
    // for going round the hub/bumps) at the speed this robot really reaches, plus time to get going.
    const straight = Math.hypot(spotNow.x - me.x, spotNow.z - me.z);
    const crossing = Math.sign(me.x - hub.x) !== Math.sign(spotNow.x - hub.x) ? 1.3 : 1.1;
    const travel = ((straight * crossing) / Math.max(2.2, (B.vmax || 3.5) * 0.75)) * 1.25 + (crossing > 1.2 ? 1.8 : 1.0); // margin: better a second early than late
    // a tighter estimate for the last volley of a period: drive at the speed we really reach, plus firing time
    const fireRate = (cfg && cfg.shooter && cfg.shooter.fireRate) || 15;
    const fireTime = Math.min(hop, cap) / fireRate + 0.35;
    const travelTight = (straight * crossing) / Math.max(2.4, (B.vmax || 3.5) * 0.85) + 0.45;
    const offShift = !timing.active;
    // The hub keeps counting fuel for 3 s after a shift ends: keep firing a little longer (fuel flies ~1 s).
    if (B.prevActive && !timing.active) B.hubOffAt = now;
    B.prevActive = timing.active;
    const inGrace = offShift && view.phase !== 'auto' && now - (B.hubOffAt || -1e9) < P.postFire * 1000;
    // always head back with 2 seconds left in the off shift
    // be back in position BY 2 seconds left: leave when the trip home would just get us there
    if (!offShift) B.committedBack = false;
    // once we've started back we stay committed (the trip estimate shrinks as we get closer)
    const mustHead = offShift && (timing.untilActive <= RETURN_AT + travel || B.committedBack);
    if (mustHead) B.committedBack = true;
    const reloading = offShift && !mustHead && timing.untilActive <= RETURN_AT + travel + P.prepTime;
    const freeTime = offShift && !mustHead && !reloading;

    // --- defense (multiplayer only): when our hub is off and theirs is on, stop their shots ---
    const opp = robot.alliance === 'blue' ? 'red' : 'blue';
    const oppActive = !!(view.hubs && view.hubs[opp] && view.hubs[opp].active);
    const oppTower = rectFor('tower', opp);
    if (B.foulPending) {
      B.foulPending = false;
      const near = view.robots.filter((o) => o.alliance !== robot.alliance)
        .sort((a, b2) => Math.hypot(a.pos[0] - me.x, a.pos[2] - me.z) - Math.hypot(b2.pos[0] - me.x, b2.pos[2] - me.z))[0];
      B.foulBan = { id: near ? near.id : -1, x: me.x, z: me.z, until: now + 10000 };
    }
    // Off-limits: an opponent at its tower in the endgame (touching a climber is a major foul),
    // anyone we just drew a foul on, and anyone near a spot where we drew one.
    const protectedFoe = (o) => {
      const ox = o.pos[0], oz = o.pos[2];
      if ((view.phase === 'endgame' || /CLIMB|HANG|TOWER/i.test(o.state || '')) && inRect(oppTower, ox, oz, 1.4)) return true;
      if (B.foulBan && now < B.foulBan.until && (o.id === B.foulBan.id || Math.hypot(ox - B.foulBan.x, oz - B.foulBan.z) < 2)) return true;
      return false;
    };
    const allFoes = view.robots.filter((o) => o.alliance !== robot.alliance);
    const foes = allFoes.filter((o) => !protectedFoe(o));
    const defenseOn = SETTINGS.defense && B.multiplayer && foes.length > 0;
    // remember where each opponent likes to shoot from, so we can stand there before they arrive
    if (defenseOn) {
      B.oppSpots = B.oppSpots || {};
      for (const o of foes) if (/SHOOT|SCOR/.test(o.state || '')) {
        const L = (B.oppSpots[o.id] = B.oppSpots[o.id] || []);
        const last = L[L.length - 1];
        if (!last || Math.hypot(last.x - o.pos[0], last.z - o.pos[2]) > 0.8) { L.push({ x: o.pos[0], z: o.pos[2] }); if (L.length > 6) L.shift(); }
      }
    }
    // get into position a few seconds before their hub turns on: they unload in the first seconds
    // (only with a full hopper: we always fill up before going to defend)
    const preDefend = defenseOn && timing.active && /^shift[1-3]$/.test(view.phase) &&
      timing.untilInactive <= P.defLead && full && now > (B.defPauseUntil || 0);
    const bumpOnly = SETTINGS.bumpOnly && B.multiplayer && foes.length > 0 && view.phase !== 'auto';
    const defenseOnly = bumpOnly || (SETTINGS.defenseOnly && B.multiplayer && foes.length > 0 && view.phase !== 'auto');
    // defend right up until 2 seconds before our shift, then come back
    const dHub0 = Math.hypot(hub.x - me.x, hub.z - me.z);
    const inRangeNowEarly = dHub0 > info.minR + 0.15 && dHub0 < info.maxR - 0.4 && depth < ZONE_DEPTH - 0.5;
    const graceShooting = inGrace && hop > 0 && (/^shooting/.test(B.mode || '') || inRangeNowEarly);
    // normal play: fill the hopper first, then defend (and come back full to score). "Full enough" = full,
    // or 60%+ and the intake has stopped finding fuel for 2.5 s (a picked-over field may never fill a big hopper)
    const fullForDefense = full || (rawHop >= cap * 0.6 && now - (B.hopRiseAt || now) > 2500);
    const defendNow = !graceShooting && (defenseOnly || preDefend) || (defenseOn && offShift && !mustHead && oppActive && fullForDefense &&
      now > (B.defPauseUntil || 0) && timing.untilActive > RETURN_AT + travel);
    if (!defendNow && B.mode && /^(defending|blocking shots|shoving|backing off)$/.test(B.mode)) {
      B.defTarget = null;
      if (robot.state === 'BLOCKING') tapKey('KeyX', now); // put the blocker away
    }

    // finish a pass that has started
    const passing = !defendNow && B.mode === 'passing' && hop > 0 && now - B.passStart < 4000 &&
      (freeTime || (reloading && timing.untilActive - (RETURN_AT + travel) > 2)); // finish the pass we started
    const timeToDepart = timing.untilActive - (RETURN_AT + travel);
    const fullEarly = offShift && !mustHead && view.phase !== 'auto' && full;
    // full with time to spare: pass this load and refill, so we still come back with a full hopper
    if (!offShift) B.passFails = 0;
    const passBanned = (B.passFails || 0) >= 2; // passes keep failing this off shift: stop trying
    const keepForDefense = defenseOn && oppActive && offShift; // going to defend with a full hopper: don't pass it away
    const wantPass = !defendNow && !graceShooting && !passBanned && !keepForDefense && hop >= 3 && ((freeTime && hop >= P.passLoad * cap) || (fullEarly && reloading && timeToDepart > 3));

    const dHubNow = Math.hypot(hub.x - me.x, hub.z - me.z);
    const inOurZone = depth < ZONE_DEPTH - 0.5; // whole robot inside our alliance zone (else the game makes it a pass)
    const inRangeNow = dHubNow > info.minR + 0.15 && dHubNow < info.maxR - 0.4 && inOurZone;
    // AUTO: keep the preload, go fill up from the centre first, then shoot the whole load after each swipe
    // (each straight run through the centre ends by setting autoNeedShoot once the hopper is mostly full)
    if (hop === 0) { B.autoNeedShoot = false; B.topOffWorth = true; B.deadlineShoot = false; if (B.hadFuel) B.cycleStart = now; B.hadFuel = false; } else B.hadFuel = true; // a new cycle starts when we're empty
    // (no rush at the end of auto: our hub stays on through the gap and the transition, and auto fuel is worth
    // the same as teleop fuel, so a full load still counts if it's fired a few seconds later)
    // auto: dumpers come back full; others when topping up stops paying off (autoNeedShoot), or at 90%
    const autoShoot = view.phase === 'auto' && hop > 0 && (B.autoNeedShoot || B.mode === 'shooting' || B.mode === 'shooting on the move' || hop >= cap * 0.9);
    const turretSweep = info.turret && timing.active && view.phase !== 'auto' && inRangeNow && (B.zoneFuel || 0) >= 8 &&
      turretChassisYaw(hub.x, hub.z) == null && hop < cap - 1;
    const goShoot = !turretSweep && !defendNow && !wantPass && !passing && hop > 0 && (autoShoot || graceShooting ||
      (fullEarly && reloading && timeToDepart <= 3) || // full and nearly time anyway: head in, get set to fire
      (timing.active && view.phase !== 'auto' && (hop >= minLoad || full ||
        (B.noRunSince && now - B.noRunSince > 2500 && hop >= 4) || // (nothing left worth collecting: shoot what we have)
        B.mode === 'shooting' || B.mode === 'shooting on the move' || // keep going once a volley has started
        (!info.dumper && B.topOffWorth === false && hop >= Math.max(4, cap * 0.3)) || (B.deadlineShoot && hop >= 1) ||
        (B.mode === 'to-hub' && hop >= 3) ||
        (view.phase === 'endgame' && hop >= 3 && (view.clock || 0) < travelTight + fireTime + 0.2 && !(B.task && B.task.type === 'run')) ||
        (timing.untilInactive < travelTight + fireTime + 0.6 && hop >= 3))) ||
      (mustHead && hop >= Math.min(minLoad, 3))
    );

    let vx = 0, vz = 0, wantYaw = null;
    if (!(B.task && B.task.stage && B.task.type !== 'pile')) B.taskActive = false;
    if (!goShoot) B.turretStop = null;
    const stow = (on) => sendKey('KeyE', on && !held.has('ShiftLeft'));
    // between jobs: dumpers keep intaking (only off while shooting); everyone else folds the intake in
    const intakeIdle = () => { if (info.dumper) { sendKey('KeyE', false); sendKey('ShiftLeft', true); } else { sendKey('ShiftLeft', false); stow(true); } };
    if (B.mode !== 'shooting') B.shootSession = false;
    if (offShift && B.task && /^(sweep|depot|tower)$/.test(B.task.type)) B.task = null; // no wall/depot/tower runs off shift

    // COPY THE PROS, 1:1: replay the best learned run for this robot second by second (singleplayer): drive where
    // they drove, face the way they faced, and shoot / pass / intake when they did
    const track = SETTINGS.replicatePros && !B.multiplayer && pro && pro.track && pro.track.length > 100 ? pro.track : null;
    const tM = matchTime(view.phase, view.clock);
    if (track && tM != null && view.phase !== 'gap') {
      if (B.match) B.match.replicate = pro.trackBy || 'a pro';
      // Follow by progress along their path (keyboard driving can't match their timing to the tenth of a second):
      // move on to their next point once we're there; where they stood still (shooting, passing) stand there as long as
      // they did; never fall more than 2.5 s behind them (then skip ahead), never get ahead of them.
      const idxAt = (t) => { let lo = 0, hi = track.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (track[mid][0] < t) lo = mid + 1; else hi = mid; } return lo; };
      const P_ = (i) => W([track[i][1], track[i][2]]);
      if (B.rk == null || B.rkMatch !== B.match) { B.rk = idxAt(tM); B.rkMatch = B.match; B.rkLag = 0; }
      let k = B.rk;
      const stillAt = (i) => i + 1 < track.length && Math.hypot(track[i + 1][1] - track[i][1], track[i + 1][2] - track[i][2]) < 0.04;
      if (stillAt(k) && Math.hypot(P_(k).x - me.x, P_(k).z - me.z) < 0.6) {
        if (B.rkStillFrom == null) { B.rkStillFrom = k; B.rkLag = tM - track[k][0]; }
        let k2 = Math.max(k, idxAt(tM - B.rkLag)); // standing where they stood: keep their timing for this stretch
        // they fired from here: if we still have fuel when their stop ends, stay and finish (up to 2.3 s behind them)
        let last = k, fired = 0; while (last + 1 < track.length && stillAt(last)) { fired |= track[last][4]; last++; }
        fired |= track[last][4];
        if ((fired & 3) && hop > 0 && k2 >= last && tM - track[last][0] < 2.3) k2 = Math.max(k, last - 1);
        B.rkFired = fired;
        k = k2;
      } else {
        B.rkStillFrom = null;
        // (stop at the first point where they stood still: that stretch is then played out on their timing above)
        while (k + 1 < track.length && track[k + 1][0] <= tM + 0.25 && !stillAt(k) &&
          Math.hypot(P_(k + 1).x - me.x, P_(k + 1).z - me.z) <= Math.hypot(P_(k).x - me.x, P_(k).z - me.z) + 0.05) k++;
      }
      k = Math.max(k, idxAt(tM - 2.5)); // too far behind: skip ahead
      B.rk = k;
      const ka = Math.min(track.length - 1, k + 4), p0 = P_(k), pa = P_(ka);
      const dtA = Math.max(0.1, track[ka][0] - track[k][0]);
      const ahead = track[k][0] > tM + 0.3; // (can't happen often: we only advance up to "now")
      const ex = pa.x - me.x, ez = pa.z - me.z;
      const vm = Math.max(3, B.vmax || 4);
      if (Math.hypot(p0.x - me.x, p0.z - me.z) > 2.0) { const r = followTo(now, me, pa, P, false); vx = r.vx; vz = r.vz; } // way off: route back
      else if (!ahead) {
        const sp = Math.hypot(pa.x - p0.x, pa.z - p0.z) / dtA; // their speed here
        const d = Math.hypot(ex, ez) || 1, want = Math.min(vm, sp + 1.8 * Math.max(0, d - 0.15));
        vx = (ex / d) * (want / vm); vz = (ez / d) * (want / vm);
      }
      const act = track[k][4] | track[Math.min(track.length - 1, k + 1)][4] | (B.rkStillFrom != null ? (B.rkFired || 0) & 3 : 0);
      const inZoneNow = depth < ZONE_DEPTH - 0.5;
      const shootNow = !!(act & 1) && inZoneNow && hop > 0, passNow = !!(act & 2) && !inZoneNow && hop > 0;
      if (shootNow || passNow) { if (info.turret) { vx *= 0.3; vz *= 0.3; } else { vx = 0; vz = 0; } } // stopped to fire (turrets may creep)
      sendKey('Space', shootNow || passNow); // the game aims; in our zone it scores, outside it passes
      sendKey('KeyE', false);
      sendKey('ShiftLeft', !(shootNow || passNow) || info.dumper || !!(act & 4));
      wantYaw = shootNow || passNow ? null : (robot.alliance === 'blue' ? track[ka][3] : wrap(track[ka][3] + Math.PI));
      B.mode = shootNow ? 'replay: shooting' : passNow ? 'replay: passing' : 'replaying a pro';
      B.task = null; B.nearGoal = true;
      drive(vx, vz, wantYaw, yaw, sx);
      B.wantMove = false; B.lastCmd = null;
      return;
    }

    // AUTO for turrets: two full swipes, then roll slowly to our depot shooting on the move, and finish auto
    // scooping the depot (that fuel goes up as soon as teleop starts)
    const depotR = rectFor('depot', robot.alliance);
    if (view.phase !== 'auto') B.fin = null;
    if (view.phase === 'auto' && info.turret && !B.fin && (B.autoVolleys || 0) >= 2 && (view.clock || 0) > 2.5) {
      let dn = 0; const F = view.fuel, Wh = F && F.where && F.where.length >= F.count ? F.where : null;
      if (F && F.pos) for (let k = 0; k < F.count; k++) if ((!Wh || Wh[k] <= 1) && inRect(depotR, F.pos[3 * k], F.pos[3 * k + 2], 0.15)) dn++;
      if (dn >= 6) { B.fin = { stage: 'go', t: now }; B.note = `Auto: shooting on the move to the depot (${dn} fuel there)`; }
    }
    if (B.fin && view.phase === 'auto') {
      B.task = null;
      const front = { x: (inward > 0 ? depotR.x1 : depotR.x0) + inward * (info.halfW + 0.35), z: (depotR.z0 + depotR.z1) / 2 };
      const towardWall = yawToFace(s, 0, mouthSign);
      const fire = hop > 0 && inRangeNow;
      sendKey('Space', fire);
      sendKey('KeyE', false); sendKey('ShiftLeft', true);
      if (B.fin.stage === 'go') {
        const r = followTo(now, me, front, P, true);
        // slow while shooting, so the shots still land
        const lim = fire ? clamp((info.maxShotSpeed || 1.5) / Math.max(3, B.vmax || 4), 0.3, 0.7) : 1;
        vx = r.vx * lim; vz = r.vz * lim;
        wantYaw = r.dGoal < 2.2 ? towardWall : null; // the turret aims itself; turn the intake to the depot on the way
        if (fire) { const ty = turretChassisYaw(hub.x, hub.z); if (ty != null && r.dGoal > 1.2) wantYaw = ty; }
        if (r.dGoal < 0.35 || (r.dGoal < 0.7 && speed < 0.2) || now - B.fin.t > 6000) B.fin = { stage: 'in', t: now };
        B.mode = fire ? 'shooting on the move' : 'to the depot';
      } else {
        // into the depot intake first (until the bumper meets its rail), with a wiggle so the pile breaks up
        wantYaw = towardWall;
        vx = s * (depth > 1.2 ? 0.4 : 0.12); vz = Math.sin(now / 170) * 0.35;
        B.mode = 'clearing depot';
      }
      B.nearGoal = true;
      drive(vx, vz, wantYaw, yaw, sx);
      B.wantMove = false; B.lastCmd = null;
      return;
    }

    if (defendNow) {
      B.task = null;
      sendKey('Space', false);
      if (info.blocker) { sendKey('ShiftLeft', false); stow(true); } // the intake would also fold a blocker away
      else intakeIdle();
      const oppHub = hubOf(opp), os = allianceSign(opp);
      // pick the most dangerous opponent: loaded, in range of their hub, already shooting
      let best = null, bestT = -1;
      for (const o of foes) {
        const ox = o.pos[0], oz = o.pos[2];
        const dHub = Math.hypot(ox - oppHub.x, oz - oppHub.z);
        const inZone = os * (ox - oppHub.x) > -0.3;
        const shooting = /SHOOT|SCOR|AIM|FIRING/.test(o.state || '');
        let t = ((o.hopperFuel || 0) + 3) * (inZone && dHub > 1.1 && dHub < 6.2 ? 2 : 0.6) * (shooting ? 1.8 : 1) /
          (Math.hypot(ox - me.x, oz - me.z) + 2);
        if (!(o.hopperFuel > 2)) t += 1.5 / (Math.abs(os * ox - 3.6) + 0.5); // empty and near their exit: about to leave
        if (B.defTarget === o.id) t *= 1.4; // stick with who we're guarding
        if (t > bestT) { bestT = t; best = o; }
      }
      if (bumpOnly) {
        const crestX = os * Math.abs(HUB_X); // the bumps' crest lines up with their hub
        let bt = Infinity;
        for (const f of foes) {
          const fx = f.pos[0], fz = f.pos[2], fvx = (f.vel && f.vel[0]) || 0;
          const lz = Math.sign(fz || 1) * clamp(Math.abs(fz), 0.85, 2.2);
          let d = Math.hypot(fx - crestX, fz - lz) - Math.sign(crestX - fx) * fvx * 0.8; // heading for it = closer
          if (B.defTarget === f.id) d -= 0.5;
          if (d < bt) { bt = d; best = f; }
        }
      }
      const o = best;
      B.defTarget = o.id;
      const ox = o.pos[0], oz = o.pos[2], ovx = (o.vel && o.vel[0]) || 0, ovz = (o.vel && o.vel[2]) || 0;
      const toHubX = oppHub.x - ox, toHubZ = oppHub.z - oz, nh = Math.hypot(toHubX, toHubZ) || 1;
      const ux = toHubX / nh, uz = toHubZ / nh; // their shot direction
      const dO = Math.hypot(ox - me.x, oz - me.z);
      const keepOut = (g) => { // never park on top of their hub
        const hx = g.x - oppHub.x, hz = g.z - oppHub.z, hn = Math.hypot(hx, hz);
        if (hn < 1.35) { g.x = oppHub.x + (hx / (hn || 1)) * 1.35; g.z = oppHub.z + (hz / (hn || 1)) * 1.35; }
        g.x = clamp(g.x, -FIELD.halfX + 0.5, FIELD.halfX - 0.5); g.z = clamp(g.z, -FIELD.halfZ + 0.5, FIELD.halfZ - 0.5);
        if (view.phase === 'endgame' && inRect(oppTower, g.x, g.z, 1.8)) g.x = os * (FIELD.halfX - (oppTower.x1 - oppTower.x0) - 2.0);
        return g;
      };
      const goTo = (g, gain = 1.6) => {
        const dx = g.x - me.x, dz = g.z - me.z, d = Math.hypot(dx, dz);
        if (d > 1.4) { const r = followTo(now, me, g, P, true); return { vx: r.vx, vz: r.vz, d }; } // route around hub/bumps
        const m = clamp(d * gain, 0, 1) / (d || 1);
        return { vx: dx * m, vz: dz * m, d };
      };
      // Pin detection (us on them): pressing a robot that can't move against a wall or field element.
      // Release well before the 3-second pinning limit, then stay 2 m away for 3 seconds.
      const pinningThem = dO < 1.05 && Math.hypot(ovx, ovz) < 0.3 && againstSolid(ox, oz, ox - me.x, oz - me.z);
      if (pinningThem) { if (!B.pinningSince) B.pinningSince = now; } else B.pinningSince = 0;
      if (B.pinningSince && now - B.pinningSince > 1600) {
        B.releaseUntil = now + 3000; B.releaseFrom = o.id; B.pinningSince = 0;
        if (B.match) B.match.pinsReleased++;
        B.note = `Released ${o.team} before a pinning foul`;
      }
      if (now < (B.releaseUntil || 0)) {
        const rel = foes.find((f) => f.id === B.releaseFrom) || o;
        const rx = me.x - rel.pos[0], rz = me.z - rel.pos[2], rd = Math.hypot(rx, rz) || 1;
        if (robot.state === 'BLOCKING') tapKey('KeyX', now);
        B.mode = 'releasing pin';
        if (rd < 2.1) { vx = rx / rd; vz = rz / rd; }
        B.nearGoal = true;
        drive(vx, vz, null, yaw, sx);
        B.wantMove = false; B.lastCmd = null;
        return;
      }
      // Lane guard: the four ways out of their zone are two bumps (beside the hub) and two trenches
      // (along the side walls). Wait in the lane they're heading for, ram them when they're at it, and
      // drive them back the way they came, but never chase far from the lane (no overcommitting).
      const crest = Math.abs(HUB_X); // bumps and trenches line up with their hub
      const laneFor = (z) => {
        const a = Math.abs(z), sg = Math.sign(z || 1);
        if (a < 2.6) return { kind: 'bump', z: sg * clamp(a, 0.85, 2.2) };
        return { kind: 'trench', z: sg * clamp(a, 3.0, 3.45) };
      };
      const atLane = (x, z) => Math.abs(Math.abs(x) - crest) < 1.6 && Math.abs(z) > 0.45;
      const bumpRam = (backDir, trench) => {
        const px = ox + ovx * 0.35 - me.x, pz = oz + ovz * 0.35 - me.z, pn = Math.hypot(px, pz) || 1;
        // in a trench push mostly along the lane, not into the side wall (that would be a pin)
        const rx = (px / pn) * 0.6 + backDir * 0.6, rz = (pz / pn) * (trench ? 0.35 : 0.9);
        const rn = Math.hypot(rx, rz) || 1;
        vx = (rx / rn) * P.bumpPush; vz = (rz / rn) * P.bumpPush;
        B.mode = 'bump defense';
      };
      const guardLane = (backDir, idleMode) => {
        // stick to the lane we're covering until they're actually coming at a different one;
        // crossing to the far side means going all the way round the hub
        let L = laneFor(oz + ovz * 0.5);
        const committed = Math.abs(Math.abs(ox) - crest) < 3.0;
        if (B.lane && !committed) L = B.lane;
        B.lane = L;
        const home = { x: os * (L.kind === 'trench' ? crest - 1.05 : crest - 0.45), z: L.z };
        const threat = atLane(ox, oz) && dO < 1.9;
        if (threat && now > (B.ramCooldownUntil || 0)) {
          if (!B.ramSince) B.ramSince = now;
          if (now - B.ramSince > 2500) { B.ramCooldownUntil = now + 900; B.ramSince = 0; } // reset to the spot
          const inBox = Math.abs(me.x - home.x) < 1.3 && Math.abs(me.z - home.z) < 1.4;
          if (inBox || dO < 1.1) { bumpRam(backDir, L.kind === 'trench'); return; }
        } else if (!threat) B.ramSince = 0;
        const r = goTo(home, 2.4);
        vx = r.vx; vz = r.vz;
        B.mode = idleMode || (L.kind === 'trench' ? 'guarding trench' : 'guarding bump');
      };
      // contact timer: never stay in contact long enough to be called for pinning
      if (dO < 1.0) { if (!B.contactSince) B.contactSince = now; } else B.contactSince = 0;
      // (real pins against walls/elements are handled exactly above; plain pushing can go on longer)
      const contactLimit = B.mode === 'bump defense' ? 3000 : 4000; // ramming has its own 2.5 s reset
      if (B.contactSince && now - B.contactSince > contactLimit) { B.backoffUntil = now + 700; B.contactSince = 0; }
      // Keep them in their zone: if they're empty (heading out to collect) or their hub is off,
      // wait at the exits of their zone (bumps/trenches) mirroring them, and push them back in.
      const oLoaded = (o.hopperFuel || 0) >= 3;
      const contain = !(oLoaded && (oppActive || preDefend));
      if (now < (B.backoffUntil || 0)) {
        B.mode = 'backing off';
        vx = (me.x - ox) / (dO || 1) * 0.8; vz = (me.z - oz) / (dO || 1) * 0.8;
        if (robot.state === 'BLOCKING') tapKey('KeyX', now);
      } else if (bumpOnly) {
        if (robot.state === 'BLOCKING') tapKey('KeyX', now);
        // push them back the way they came: empty ones back into their zone, loaded ones back out
        guardLane(Math.abs(ovx) > 0.3 ? -Math.sign(ovx) : ((o.hopperFuel || 0) > 2 ? -os : os));
      } else if (contain) {
        if (robot.state === 'BLOCKING') tapKey('KeyX', now);
        if (os * ox > 3.0) {
          // still inside (or at the edge of) their zone: goalkeep the exit they're heading for
          // guard the bump or trench they're heading for and ram them back into their zone
          guardLane(os, 'containing');
        } else {
          // they got out: get on the field side of them and push them back toward their zone
          if (dO > 1.4) { const r = goTo({ x: ox - os * 1.0, z: oz }); vx = r.vx; vz = r.vz; }
          else { vx = os * P.shoveSpeed; vz = (oz - me.z) * 0.8; }
          B.mode = 'pushing back';
        }
      } else if (dO > 3.2 && B.oppSpots && (B.oppSpots[o.id] || []).length && !/SHOOT|SCOR|AIM/.test(o.state || '')) {
        // they're off collecting: stand on the spot they shoot from so they can't set up there
        const L = B.oppSpots[o.id];
        let sx2 = 0, sz2 = 0; for (const q of L) { sx2 += q.x; sz2 += q.z; }
        const g = keepOut({ x: sx2 / L.length, z: sz2 / L.length });
        const r = goTo(g);
        vx = r.vx; vz = r.vz;
        if (info.blocker) wantYaw = wrap(yawToFace(oppHub.x - g.x, oppHub.z - g.z, 1) + (P.blockTwist * Math.PI) / 180);
        if (robot.state === 'BLOCKING') tapKey('KeyX', now);
        B.mode = 'defending';
      } else if (info.blocker && robotTop(o.team) < TALL) {
        // MadTown-style shot blocker (only against robots short enough for the plate to reach): stand in their shot lane close to the shooter, broadside, flap up
        // A shooter in the trench lane (along the side wall): come up alongside it on the field side
        const inTrench = (Math.abs(oz) > 2.4 && Math.abs(ox) > 2.6 && Math.abs(ox) < 5.0) || Math.abs(oz) > 3.0;
        const g = inTrench
          ? keepOut({ x: ox + ux * 0.3 + ovx * 0.3, z: oz - Math.sign(oz) * 0.98 + uz * 0.3 })
          : keepOut({ x: ox + ux * P.blockDist + ovx * 0.3, z: oz + uz * P.blockDist + ovz * 0.3 });
        const r = goTo(g, 2);
        vx = r.vx; vz = r.vz;
        wantYaw = wrap(yawToFace(ux, uz, 1) + (P.blockTwist * Math.PI) / 180); // back (and plate) to the shooter
        // only raise the blocker when they're actually set up to shoot (shooting, or slowed down in range)
        const oDHub = Math.hypot(ox - oppHub.x, oz - oppHub.z);
        const setUp = /SHOOT|SCOR|AIM|FIRING/.test(o.state || '') ||
          (os * (ox - oppHub.x) > -0.3 && oDHub > 1.1 && oDHub < 6 && Math.hypot(ovx, ovz) < 0.8 && (o.hopperFuel || 0) > 0);
        const wantOut = r.d < 1.0 && setUp;
        const isOut = robot.state === 'BLOCKING';
        if (wantOut !== isOut) tapKey('KeyX', now);
        // with the blocker up, back into the shooter: keeps the plate tight on their shot and shoves their aim
        // (pin detection above still lets go before a pinning foul)
        if ((isOut || wantOut) && dO < 1.8 && !inTrench) { // (in the trench a shove would pin them on the wall)
          const px = (ox - me.x) / (dO || 1), pz = (oz - me.z) / (dO || 1);
          vx = r.vx * 0.3 + px * P.shoveSpeed; vz = r.vz * 0.3 + pz * P.shoveSpeed;
        }
        B.mode = isOut ? 'blocking shots' : 'defending';
        if (!setUp) wantYaw = null; // no point turning to a lane nobody is shooting down
      } else {
        const shooterStill = Math.hypot(ovx, ovz) < 0.6;
        if (dO > 1.5 || !shooterStill) {
          // shadow them: sit between them and their hub, a little ahead of where they're going
          const g = keepOut({ x: ox + ux * 1.15 + ovx * 0.4, z: oz + uz * 1.15 + ovz * 0.4 });
          const r = goTo(g);
          vx = r.vx; vz = r.vz;
          B.mode = 'defending';
        } else {
          // they're parked and shooting: shove them sideways to wreck their aim
          const px = -uz, pz = ux; // across their shot
          const side = Math.sign((me.x - ox) * px + (me.z - oz) * pz) || 1;
          const dx = (ox - me.x) / (dO || 1) - px * side * 0.6, dz = (oz - me.z) / (dO || 1) - pz * side * 0.6;
          const n = Math.hypot(dx, dz) || 1;
          vx = (dx / n) * P.shoveSpeed; vz = (dz / n) * P.shoveSpeed;
          B.mode = 'shoving';
        }
      }
      B.nearGoal = true; // pushing on purpose is not "stuck"
      drive(vx, vz, wantYaw, yaw, sx);
      B.wantMove = false; B.lastCmd = null;
      return;
    }
    if (robot.state === 'BLOCKING') tapKey('KeyX', now); // blocker away whenever we're not defending

    if (passing || wantPass) {
      // Our hub is off: lob fuel into our alliance zone from the neutral zone and go get more.
      B.task = null;
      if (B.mode === 'passing' && canPass) { sendKey('KeyE', false); sendKey('ShiftLeft', true); } // pass and intake at the same time
      else intakeIdle();
      const onMove = info.turret && info.turretHalfArc == null; // full-circle turrets keep driving to the next pile while they pass
      if (canPass) {
        if (B.mode !== 'passing') { B.passStart = now; B.passHop = rawHop; }
        B.mode = 'passing';
        sendKey('Space', true); // outside our zone the game turns "score" into a pass
        if (onMove) {
          // keep rolling toward the next pile while the turret passes
          const fuel = floorFuel(view, robot);
          const t = pickFuelTarget(fuel, me, P, null, { x: wallX + inward * (ZONE_DEPTH + 3.5), z: me.z }, 0.8, { pilesOnly: true, zone: 'neutral' });
          if (t) {
            // plow through past the pile (intake leading) at up to the turret's full passing speed
            const dxp = t.x - me.x, dzp = t.z - me.z, dp = Math.hypot(dxp, dzp) || 1;
            const r = followTo(now, me, { x: t.x + (dxp / dp) * P.plowPast, z: t.z + (dzp / dp) * P.plowPast }, P, false);
            const lim = clamp((info.maxPassSpeed || 3) / Math.max(3, B.vmax || 4), 0.5, 1.0);
            vx = r.vx * lim; vz = r.vz * lim;
            wantYaw = yawToFace(dxp, dzp, mouthSign); // turret aims itself, so face the intake at the fuel
          }
          drive(vx, vz, wantYaw, yaw, sx);
        } else drive(0, 0, turretChassisYaw(wallX + inward * (ZONE_DEPTH - 0.3), (me.z >= 0 ? 1 : -1) * 1.53), yaw, sx);
        if (rawHop < B.passHop) { B.passHop = rawHop; B.passStart = now; }
        if (now - B.passStart > 2000) {
          B.passFails = (B.passFails || 0) + 1;
          B.note = B.passFails >= 2 ? 'Passes not leaving — done passing this shift' : 'Mistake: pass not leaving — moving over';
          B.passMoveUntil = now + 1500; B.passSide = me.z > 0 ? 1 : -1; B.mode = 'to pass point';
        }
        B.wantMove = false; B.lastCmd = null; B.nearGoal = true;
        return;
      }
      sendKey('Space', false);
      B.mode = 'to pass point';
      let px = wallX + inward * (ZONE_DEPTH + 2.1);
      let pz = clamp(me.z, -FIELD.halfZ + 1.0, FIELD.halfZ - 1.0);
      if (pro && pro.passes && pro.passes.length) { // pass from the nearest spot the pros passed from
        let bd = Infinity;
        for (const q of pro.passes) { const w = W(q); if ((w.x - wallX) * inward < ZONE_DEPTH + 0.5) continue;
          const d = Math.hypot(w.x - me.x, w.z - me.z); if (d < bd) { bd = d; px = w.x; pz = w.z; } }
      }
      if (Math.abs(pz) < 1.6) pz = (pz < 0 ? -1.6 : 1.6);
      if (now < (B.passMoveUntil || 0)) pz = clamp(me.z + (B.passSide || 1) * 1.2, -FIELD.halfZ + 1.0, FIELD.halfZ - 1.0);
      const r = followTo(now, me, { x: px, z: pz }, P, true);
      vx = r.vx; vz = r.vz;
    } else if (goShoot) {
      B.task = null;
      // heading in to shoot: intake folded in (dumpers keep intaking); released while firing (lets hoppers squeeze)
      intakeIdle();
      const distHub = Math.hypot(hub.x - me.x, hub.z - me.z);
      const behind0 = inOurZone;
      const fireOK = timing.active || inGrace || (offShift && view.phase !== 'auto' && timing.untilActive <= P.preFire);
      const turretHere = info.turret && fireOK && behind0 && distHub > info.minR + 0.15 && distHub < info.maxR - 0.4;
      if (turretHere && !B.turretStop) B.turretStop = { x: me.x + (me.vx || 0) * 0.25, z: me.z + (me.vz || 0) * 0.25 };
      if (!turretHere) B.turretStop = null;
      const spot = B.turretStop || spotNow; // a turret aims itself, so any in-range spot will do
      const r = followTo(now, me, spot, P, true);
      const behindHub = inOurZone; // inside our alliance zone
      // with a stockpile in our zone, shoot from wherever we picked it up (as long as it's in range), like the pros
      const harvesting = timing.active && view.phase !== 'auto' && (B.zoneFuel || 0) >= 15;
      const inRange = distHub > info.minR + 0.15 && distHub < (harvesting ? info.maxR - 0.7 : Math.min(PS.shootDist + 0.8, info.maxR - 0.3)) && behindHub;
      const inRangeWide = distHub > info.minR + 0.15 && distHub < info.maxR - 0.4 && behindHub; // anywhere the shooter can reach
      const atSpot = r.dGoal < 0.4 || (r.dGoal < 0.8 && speed < 0.3) || (fireOK && inRange && !info.turret) ||
        (B.turretStop && speed < 0.5);
      if (atSpot) {
        if (fireOK) { // hub on, or about to come on: start the volley so the first fuel lands as it lights up
          if (!B.shootSession) { B.shootSession = true; B.jam = 0; B.shootHop = rawHop; B.shotProgress = now; B.pulses = 0; if (view.phase === 'auto') B.autoVolleys = (B.autoVolleys || 0) + 1; }
          B.mode = 'shooting';
          if (rawHop < B.shootHop) { B.shootHop = rawHop; B.shotProgress = now; B.pulses = 0; }
          // If fuel stops coming out, re-tap score. Robots with a squeezing hopper also get a short
          // intake tap right after the new press, which is how the game lets them shake fuel loose.
          const sinceTap = now - (B.pulseAt || -1e9);
          if (sinceTap > 600 && now - B.shotProgress > 1000) { B.pulses++; B.pulseAt = now; B.shotProgress = now; }
          const t2 = now - (B.pulseAt || -1e9);
          sendKey('Space', !(t2 < 150));
          // Turrets standing still (or down to the last few fuel): swing the intake in and out over and over
          // (in = Stow, out = Intake) to jostle the fuel into the shooter instead of letting it hang on the intake.
          const turretWiggle = info.turret && info.canWiggle && (speed < 0.3 || rawHop <= 8);
          const turretHold = info.turret && !info.canWiggle && (speed < 0.3 || rawHop <= 8); // plain drawer: just keep it in
          if (turretWiggle) {
            const cyc = Math.max(400, P.oscPeriod * 1000);
            const inPhase = (now % cyc) / cyc < 0.55;
            sendKey('ShiftLeft', !inPhase); // out
            stow(inPhase);                  // in
          } else if (turretHold) {
            sendKey('ShiftLeft', false); stow(true);
          } else {
            sendKey('ShiftLeft', info.agitates && t2 >= 150 && t2 < 400);
            stow(false);
          }
          axis('fwd', 0, 'KeyW', 'KeyS'); axis('side', 0, 'KeyD', 'KeyA'); axis('rot', 0, 'KeyJ', 'KeyL');
          { const ty = turretChassisYaw(hub.x, hub.z); if (ty != null) drive(0, 0, ty, yaw, sx); } // limited turret: point its swing at the hub
          setLid(false); // lid down while shooting: it feeds the shooter faster
          if (!info.turret && speed > 0.7) { // came in fast: brake rather than coast past the spot
            const vm = Math.max(3, B.vmax || 4);
            axis('fwd', -((me.vx || 0) / vm) * 1.6 * sx, 'KeyW', 'KeyS'); axis('side', -((me.vz || 0) / vm) * 1.6 * sx, 'KeyD', 'KeyA');
          }
          if (robot.gate && robot.gate.range) { // too close: back off a little
            const ax = me.x - hub.x, az = me.z - hub.z, n = Math.hypot(ax, az) || 1;
            axis('fwd', (ax / n) * 0.5 * sx, 'KeyW', 'KeyS'); axis('side', (az / n) * 0.5 * sx, 'KeyD', 'KeyA');
          }
          // the last one to three fuel won't come out: don't sit there trying, they'll go with the next load
          if (rawHop <= 3 && rawHop > 0 && now - B.shotProgress > 700 && !(robot.gate && (robot.gate.hood || robot.gate.flywheel || robot.gate.heading))) {
            B.jam = rawHop; B.pulses = 0; B.mode = 'collecting'; B.shootSession = false;
            sendKey('Space', false); sendKey('ShiftLeft', false);
            return;
          }
          if (B.pulses >= 3) {
            const g = robot.gate || {};
            if (g.hood || g.flywheel || g.heading || g.range || g.speed) {
              // the shooter isn't happy with this spot: try the other side
              MEM.stuck[cellOf(me.x, me.z)] += 0.5;
              B.match.P.shootDist = clamp(P.shootDist + (Math.random() - 0.5) * 0.8, PARAMS.shootDist.min, PARAMS.shootDist.max);
              B.match.side = -(B.match.side || 1);
              B.note = 'Mistake: shots not scoring from here — moving';
            } else {
              // fuel is jammed: don't count it, go collect, and try it again on the next volley
              B.jam = rawHop;
              B.note = `${rawHop} fuel jammed — collecting more, will retry`;
            }
            B.pulses = 0; B.mode = 'collecting'; B.shootSession = false;
            sendKey('Space', false); sendKey('ShiftLeft', false);
            return;
          }
          B.wantMove = false; B.lastCmd = null;
          return;
        }
        B.mode = 'waiting for hub';
        sendKey('Space', false);
        intakeIdle();
        drive(0, 0, null, yaw, sx);
        B.wantMove = false;
        return;
      }
      vx = r.vx; vz = r.vz;
      // turrets fire on the move as soon as they're in range of an active hub
      if (info.moveShoot && fireOK && inRangeWide) {
        if (!B.shootSession) { B.shootSession = true; B.jam = 0; if (view.phase === 'auto') B.autoVolleys = (B.autoVolleys || 0) + 1; }
        sendKey('Space', true);
        stow(false);
        B.mode = 'shooting on the move';
        { const ty = turretChassisYaw(hub.x, hub.z); if (ty != null) wantYaw = ty; }
        setLid(false);
      } else {
        sendKey('Space', false);
        B.mode = 'to-hub';
        if (r.dGoal < 2.5) setLid(false); // lid down before the volley
        // turn the shooter toward the hub on the way in, so it's already aimed when we get there
        if (!info.turret) wantYaw = r.dGoal > 1.2 ? yawToFace(hub.x - spot.x, hub.z - spot.z, info.shooterSign) : yawToFace(hub.x - me.x, hub.z - me.z, info.shooterSign);
        else if (r.dGoal < 3) { const ty = turretChassisYaw(hub.x, hub.z); if (ty != null) wantYaw = ty; }
      }
      B.nearGoal = r.dGoal < 0.5;
    } else {
      // turrets can shoot from anywhere in range: keep firing while collecting if our hub is on
      const turretFireHere = info.turret && hop > 0 && view.phase !== 'auto' && inRangeNow && turretChassisYaw(hub.x, hub.z) == null &&
        (timing.active || inGrace || (offShift && timing.untilActive <= P.preFire));
      sendKey('Space', turretFireHere);
      sendKey('KeyE', false); // intake out to collect / clean walls
      // Intake jam: fuel right at the mouth but nothing coming in for 2 s -> tap outtake to spit it out
      if (now < (B.unjamUntil || 0)) {
        sendKey('ShiftLeft', false); sendKey('KeyQ', true);
        B.mode = 'clearing intake jam'; drive(0, 0, null, yaw, sx); B.wantMove = false;
        return;
      }
      sendKey('KeyQ', false);
      if (held.has('ShiftLeft') && speed < 0.6 && now - (B.hopRiseAt || now) > 2000 && now - (B.unjamAt || 0) > 3000 && !full) {
        const ix = Math.cos(yaw) * mouthSign, iz = -Math.sin(yaw) * mouthSign; // intake direction
        const mx = me.x + ix * 0.6, mz = me.z + iz * 0.6;
        const F = view.fuel; let near = 0;
        const Wh = F && F.where && F.where.length >= F.count ? F.where : null;
        if (F && F.pos) for (let k = 0; k < F.count; k++) {
          if (Wh ? Wh[k] > 1 : F.pos[3 * k + 1] >= 0.2) continue; // in our hopper (or anywhere off the floor): not a jam
          if (Math.hypot(F.pos[3 * k] - mx, F.pos[3 * k + 2] - mz) < 0.45) near++;
        }
        if (near >= 2 && rawHop >= capRaw * 0.3) {
          MEM.effCap[robot.team] = Math.max(Math.round(capRaw * 0.3), rawHop); saveMem();
          B.note = `Hopper full at ${rawHop} — going to shoot`;
        } else if (near >= 2) {
          const again = B.unjamSpot && Math.hypot(B.unjamSpot.x - me.x, B.unjamSpot.z - me.z) < 0.8 && now - B.unjamSpot.t < 8000;
          B.unjamSpot = { x: me.x, z: me.z, t: now, n: again ? B.unjamSpot.n + 1 : 1 };
          if (B.unjamSpot.n >= 3) {
            (B.badFuel = B.badFuel || []).push({ x: mx, z: mz, until: now + 20000 });
            B.task = null; B.unjamSpot = null; B.note = 'That fuel won’t come in — leaving it';
          } else { B.unjamAt = now; B.unjamUntil = now + 350; B.note = 'Intake jammed — spitting it out'; }
        }
      }
      if (rawHop >= cap * 0.4 && !B.nearTrenchNow && !turretFireHere) setLid(true); // collecting (not firing): lid up to hold more
      else if (turretFireHere) setLid(false); // firing while it collects: lid down feeds the shooter faster
      // pick (or keep) a collection task
      // where to look: near the hub when reloading, out in the neutral zone when there is free time
      const anchorW = freeTime ? 0.8 : 0;
      const anchorPt = { x: wallX + inward * (ZONE_DEPTH + 3.5), z: me.z };
      // Straight runs through the fuel (planRun): the main way we collect, in auto and teleop.
      {
        const T0 = B.task && B.task.type === 'run' ? B.task : null;
        if (T0 && now - (T0.seen || now) > 400) B.task = null; // we went off to shoot or pass: plan afresh
        const pocketBusy = B.task && /^(sweep|depot|tower)$/.test(B.task.type) && B.task.stage !== 'approach';
        if (!pocketBusy && (!B.task || B.task.type !== 'run' || now - (B.runAt || 0) > 280)) {
          B.runAt = now;
          const all = floorFuel(view, robot), toward = -s;
          { let nz = 0; for (let k = 0; k < all.length; k += 2) if ((all[k] - wallX) * inward < ZONE_DEPTH - 0.2) nz++; B.zoneFuel = nz; } // our stockpile
          // singleplayer: nobody else is out there, so the whole field (behind their hub, their zone) is fair game
          const reachR = !B.multiplayer ? 8.3 : P.reach;
          const shiftLeft = timing.active && view.phase !== 'auto' ? (isFinite(timing.untilInactive) ? timing.untilInactive : (view.clock || 0)) : 99;
          const fuel = [];
          for (let k = 0; k < all.length; k += 2) {
            const x = all[k], z = all[k + 1];
            if (toward * x > reachR) continue;
            if (view.phase === 'auto' && B.multiplayer && s * x < 0.15) continue;           // auto in a room: our half only
            if (shiftLeft < 5 && (x - wallX) * inward > ZONE_DEPTH - 0.2) continue;         // end of our shift: close to the hub
            fuel.push(x, z);
          }
          const heat = pro && pro.heat, heatMax = heat ? Math.max(1, ...Object.values(heat)) : 1;
          const ph = view.phase === 'auto' ? 0 : offShift ? 2 : 1;
          const lines = pro && pro.fills ? pro.fills.filter((f) => (f[5] === 3 ? 1 : f[5]) === ph).slice(0, 40)
            .map((f) => { const a0 = W([f[0], f[1]]), a1 = W([f[2], f[3]]); return [a0.x, a0.z, a1.x, a1.z]; }) : null;
          const v = Math.max(2.4, (B.vmax || 3.5) * 0.8);
          const shootNext = view.phase === 'auto' || timing.active || reloading || mustHead;
          const o = {
            hw: info.halfW, mouth: info.mouthHalf, reach: info.mouthReach, v, yaw, mouthSign, trench: !B.noTrench,
            capLeft: Math.max(1, cap - rawHop),
            // seconds from the end of a run back to where we can shoot (just inside our zone, beside the hub)
            back: shootNext ? (x, z) => {
              const dIn = Math.max(0, (x - wallX) * inward - (ZONE_DEPTH - 0.62));
              const around = Math.abs(z) < 1.25 && dIn > 0 ? 1.25 - Math.abs(z) : 0;
              return ((dIn + around) * 1.15) / v + 0.4;
            } : null,
            weight: (x, z) => {
              let w = OTHERS.length && robotNear(x, z, 1.0) ? 0.25 : 1;
              if (heat) { const nx = robot.alliance === 'blue' ? x : -x, nz = robot.alliance === 'blue' ? z : -z; w *= 1 + 0.3 * ((heat[Math.round(nx / 0.8) + ',' + Math.round(nz / 0.8)] || 0) / heatMax); }
              return w;
            },
            lines,
          };
          // Deadline: the end of the match (fuel fired before the buzzer still counts as it lands), or our hub going
          // off at the end of a shift (it counts for a moment after). Auto has none: the hub stays on into teleop.
          const tEnd = view.phase === 'endgame' ? (view.clock || 0) - 0.15
            : view.phase !== 'auto' && timing.active && isFinite(timing.untilInactive) && timing.untilInactive < 20 ? timing.untilInactive + P.postFire * 0.5 : null;
          if (tEnd != null) { o.deadline = tEnd; o.hop = rawHop; o.fireRate = fireRate; }
          if (view.phase === 'auto' && info.dumper) o.preferFill = true; // dumpers in auto: one pass that fills the hopper
          const best = planRun(fuel, me, o);
          // (o.deadline is also used by rerateRun just below)
          // no run fits before the deadline: go and shoot what we have now, rather than wander and miss the buzzer
          B.deadlineShoot = tEnd != null && !best && rawHop >= 1;
          if (!best) B.noRunSince = B.noRunSince || now; else B.noRunSince = 0;
          const cur = T0 && B.task === T0 ? (T0.stage === 'go' ? rerateRun(fuel, me, T0, o) : tEnd != null && !best ? null : T0.rate * 0.9) : null;
          if (best && best.rate > 1.0 && (!T0 || B.task !== T0 || cur == null || best.rate > cur * 1.3)) {
            B.task = { type: 'run', ...best, stage: best.pre ? 'approach' : 'go', t0: now, ts: now, seen: now };
          } else if (T0 && B.task === T0 && cur == null) {
            B.task = null; // nothing left on this line
          }
          // Go shoot when topping off would add less fuel per second than this cycle is averaging (fuel so far
          // over the time since our last volley, plus the drive home and the volley itself).
          const cycleRate = (rawHop + 1) / Math.max(1, (now - (B.cycleStart || now)) / 1000 + (o.back ? o.back(me.x, me.z) : 1.5) + rawHop / fireRate + 0.9);
          B.topOffWorth = !(rawHop >= Math.max(4, cap * 0.3) && (!best || best.rate < cycleRate));
          // auto: dumpers go back full (or when nothing's left in reach); others when topping up stops paying off
          if (view.phase === 'auto' && rawHop >= 4 && (rawHop >= cap * 0.9 || !best || (!info.dumper && !B.topOffWorth))) B.autoNeedShoot = true;
        }
      }
      const busy = B.task && (B.task.type === 'run' || B.task.type === 'swipe' || (B.task.type !== 'pile' && B.task.stage !== 'approach'));
      if (!busy && (!B.task || now - B.targetAt > 700)) {
        const fuel = floorFuel(view, robot);
        // Hub on: go where the fuel is. More in the neutral zone -> go get it; but with under 5 s left in
        // the shift, clean up our own alliance zone (close to the hub) instead.
        let zone = null;
        if (timing.active && view.phase !== 'auto') {
          const shiftLeft = isFinite(timing.untilInactive) ? timing.untilInactive : (view.clock || 0);
          let ours = 0, neutral = 0;
          for (let k = 0; k < fuel.length; k += 2) {
            const fd = (fuel[k] - wallX) * inward;
            if (fd < ZONE_DEPTH - 0.2) ours++; else if (fd > ZONE_DEPTH + 0.3 && fd < 2 * FIELD.halfX - ZONE_DEPTH) neutral++;
          }
          if (shiftLeft < 5) zone = 'ours';
          else if (neutral > ours) zone = 'neutral';
          B.zonePick = zone;
        }
        const t = pickFuelTarget(fuel, me, P, B.task, anchorW ? anchorPt : null, anchorW,
          { pilesOnly: view.phase === 'auto' || offShift || zone === 'neutral', zone,
            heat: pro && pro.heat, heatMax: pro && Math.max(1, ...Object.values(pro.heat || { a: 1 })),
            reach: view.phase === 'auto' && !B.multiplayer ? 8 : undefined }); // singleplayer auto: whole field
        if (!B.task || !t || t.type !== B.task.type || Math.hypot(t.x - B.task.x, t.z - B.task.z) > 0.7) B.task = t ? { ...t, stage: 'approach', t0: now } : null;
        B.targetAt = now;
      }
      if (!B.task) {
        B.mode = 'no fuel in reach';
        B.task = { type: 'pile', x: hub.x + s * 2.2, z: 0, n: 0, stage: 'approach', t0: now };
      }
      const T = B.task;
      // Fuel we can't get (wedged against a wall, the hub, a post): if we've been close to the same target for a
      // while and the hopper hasn't gone up, give up on that spot for a while instead of sitting there trying.
      if (T.type === 'run' || T.type === 'pile') {
        const tg = T.type === 'run' ? { x: T.x1, z: T.z1 } : { x: T.x, z: T.z };
        if (!B.tryT || Math.hypot(B.tryT.x - tg.x, B.tryT.z - tg.z) > 1.0 || now - B.tryT.seen > 1500) B.tryT = { x: tg.x, z: tg.z, since: now, hop: rawHop };
        B.tryT.seen = now;
        if (rawHop > B.tryT.hop) { B.tryT.hop = rawHop; B.tryT.since = now; }
        if (Math.hypot(me.x - tg.x, me.z - tg.z) < 1.6 && now - B.tryT.since > 2600) {
          (B.badFuel = B.badFuel || []).push({ x: tg.x, z: tg.z, until: now + 20000 });
          if (T.type === 'run') B.badFuel.push({ x: (T.x0 + T.x1) / 2, z: (T.z0 + T.z1) / 2, until: now + 20000 });
          B.note = 'Can’t get that fuel — leaving it for now';
          B.task = null; B.tryT = null;
        }
      }
      if (!B.task) { drive(0, 0, null, yaw, sx); B.wantMove = false; return; }
      sendKey('ShiftLeft', T.type === 'run' || !(T.stage === 'out' || T.stage === 'approach' && T.type !== 'pile' && Math.hypot(T.x - me.x, T.z - me.z) > 2));
      const towardWall = yawToFace(s, 0, mouthSign); // intake pointing at our wall
      if (T.type === 'run') {
        T.seen = now;
        B.taskActive = false;
        B.mode = T.tag === 'pro' ? 'copying a pro run' : 'collecting';
        const along = yawToFace(T.dx, T.dz, mouthSign); // intake leading down the line
        if (T.stage === 'approach') {
          const r = followTo(now, me, { x: T.x0, z: T.z0 }, P, false);
          vx = r.vx; vz = r.vz;
          // far from the start of the run: don't spend time turning yet (we turn the intake round on the way in)
          wantYaw = r.dGoal < 2.6 ? along : null;
          const pastStart = (me.x - T.x0) * T.dx + (me.z - T.z0) * T.dz > -0.15;
          if (r.dGoal < 0.45 || (r.dGoal < 1.0 && pastStart)) { T.stage = 'go'; T.ts = now; }
          if (now - T.t0 > 6000) B.task = null;
        } else {
          // flat out down the line, holding the lane; brake only if a wall or the hub is right at the end
          const px = me.x - T.x0, pz = me.z - T.z0;
          const off = pz * T.dx - px * T.dz; // sideways from the line
          const left = (T.x1 - me.x) * T.dx + (T.z1 - me.z) * T.dz;
          const yawErr = Math.abs(wrap(along - yaw));
          const toFirst = (T.firstT || 0) - ((me.x - T.x0) * T.dx + (me.z - T.z0) * T.dz); // empty floor before the first fuel
          let mag = toFirst > 1.6 ? 1 : yawErr > 1.3 ? 0.45 : yawErr > 0.7 ? 0.75 : 1;
          if (!runClear(T.x1 + T.dx * 0.45, T.z1 + T.dz * 0.45, info.halfW)) {
            mag = Math.min(mag, Math.sqrt(2 * 3.2 * Math.max(0, left)) / Math.max(3, B.vmax || 4) + 0.12);
          }
          // a turret firing while it sweeps has to stay under its shooting speed or the game holds the shots
          if (turretFireHere) mag = Math.min(mag, Math.max(0.3, ((info.maxShotSpeed || 2) * 0.9) / Math.max(3, B.vmax || 4)));
          const corr = clamp(off * 1.6, -0.5, 0.5);
          vx = T.dx * mag + T.dz * corr; vz = T.dz * mag - T.dx * corr;
          wantYaw = along;
          const fullNow = rawHop >= cap - 0.5;
          if (speed > 0.35) T.movedAt = now;
          const blocked = now - T.ts > 700 && now - (T.movedAt || T.ts) > 600; // pushing into something: stop this run
          if (left < 0.1 || fullNow || blocked || now - T.ts > (T.L / 2.0) * 1000 + 1500) {
            if (view.phase === 'auto' && rawHop >= cap * 0.9) B.autoNeedShoot = true;
            B.task = null;
          }
        }
      } else if (T.type === 'swipe') {
        const dir = Math.sign(T.zEnd - T.z) || 1;
        const along = yawToFace(0, dir, mouthSign); // intake leading along the swipe
        if (T.stage === 'approach') {
          const r = followTo(now, me, { x: T.x, z: T.z }, P, true);
          vx = r.vx; vz = r.vz;
          wantYaw = r.dGoal < 1.6 ? along : yawToFace(r.vx, r.vz, mouthSign);
          if (r.dGoal < 0.7 && Math.abs(wrap(along - yaw)) < 0.7) { T.stage = 'sweep'; T.ts = now; }
          if (r.dGoal < 0.9) { T.near = T.near || now; if (now - T.near > 900) { T.stage = 'sweep'; T.ts = now; } }
          if (now - T.t0 > 5000) { T.stage = 'sweep'; T.ts = now; }
        } else {
          wantYaw = along;
          vx = clamp((T.x - me.x) * 1.5, -0.5, 0.5); vz = dir * 0.85; // hold the lane, drive the length of the block
          if ((me.z - T.zEnd) * dir > 0 || rawHop >= cap * 0.9 || now - T.ts > 4500) {
            B.autoSwipes = (B.autoSwipes || 0) + 1;
            B.autoNeedShoot = true; // the hopper's loaded: go shoot all of it
            B.task = null;
          }
        }
        B.mode = 'auto swipe';
        B.taskActive = true;
      } else if (T.type === 'pile') {
        B.mode = B.mode === 'no fuel in reach' ? B.mode : 'collecting';
        const dx = T.x - me.x, dz = T.z - me.z, d = Math.hypot(dx, dz) || 1e-6;
        // aim a little past the pile so the intake plows through it (but never into a wall)
        const goal = {
          x: clamp(T.x + (dx / d) * P.plowPast, -FIELD.halfX + 0.55, FIELD.halfX - 0.55),
          z: clamp(T.z + (dz / d) * P.plowPast, -FIELD.halfZ + 0.55, FIELD.halfZ - 0.55),
        };
        const r = followTo(now, me, goal, P, false);
        wantYaw = yawToFace(r.vx, r.vz, mouthSign); // intake leads, facing the fuel
        const slow = Math.abs(wrap(wantYaw - yaw)) > 0.7 ? 0.35 : 1;
        vx = r.vx * slow; vz = r.vz * slow;
        if (d < 0.25) B.task = null;
      } else if (T.type === 'sweep') {
        // Back wall: hug the wall with the intake turned sideways (pointing along the wall) and drive
        // slowly, so the intake scoops up the fuel lying against it.
        B.mode = 'sweeping wall';
        const dir = Math.sign(T.zEnd - T.z) || 1;
        const along = yawToFace(0, dir, mouthSign);
        const hug = info.halfW + 0.04; // robot centre this far off the wall
        const elapsed = now - (T.ts || now);
        if (T.stage === 'approach') {
          const r = followTo(now, me, { x: wallX + inward * (hug + 0.25), z: T.z }, P, true);
          vx = r.vx; vz = r.vz;
          wantYaw = r.dGoal < 1.5 ? along : yawToFace(r.vx, r.vz, mouthSign);
          const ready = () => { T.stage = 'slide'; T.ts = now; T.movedAt = now; };
          if (r.dGoal < 0.4 && Math.abs(wrap(along - yaw)) < 0.3) ready();
          if (r.dGoal < 0.6) { T.near = T.near || now; if (now - T.near > 1500) ready(); }
          if (now - T.t0 > 9000) B.task = null;
        } else {
          B.taskActive = true;
          wantYaw = along;
          vx = clamp((wallX + inward * hug - me.x) * 2, -0.4, 0.4) + s * 0.12; // hug the wall
          vz = dir * P.sweepSpeed * 0.9;                                        // along it, intake leading
          if (speed > 0.1) T.movedAt = now;
          const done = (me.z - T.zEnd) * dir > -0.15 || full || elapsed > 9000;
          const blocked = !done && elapsed > 1200 && now - T.movedAt > 900;
          if (blocked) { MEM.stuck[cellOf(me.x, me.z + dir * 0.5)] += 1; B.note = 'Mistake: wall sweep blocked — remembering it'; }
          if (done || blocked) B.task = null;
        }
      } else {
        // pocket (depot, front of tower): stage, turn the intake to the wall, then go in
        if (now - T.t0 > 7000 && T.stage !== 'out') { // taking too long: back out and move on
          if (T.type === 'depot' && B.match) { B.match.depotFails++; B.note = 'Depot taking too long — skipping it'; }
          T.stage = 'out'; T.ts = now;
        }
        B.taskActive = T.stage !== 'approach';
        B.mode = T.type === 'sweep' ? 'sweeping wall' : T.type === 'depot' ? 'clearing depot' : 'clearing tower';
        const pocket = T.type === 'depot' || T.type === 'tower';
        const elapsed = now - (T.ts || now);
        const setStage = (st) => { T.stage = st; T.ts = now; T.hop0 = rawHop; T.p0 = { x: me.x, z: me.z }; };
        if (T.stage === 'approach') {
          const r = followTo(now, me, { x: T.x, z: T.z }, P, true);
          vx = r.vx; vz = r.vz;
          wantYaw = r.dGoal < 1.2 ? towardWall : yawToFace(r.vx, r.vz, mouthSign);
          if (r.dGoal < 0.35) setStage('face');
          if (now - T.t0 > 9000) B.task = null;
        } else if (T.stage === 'face') {
          wantYaw = towardWall;
          vz = (T.z - me.z) * 1.5; vx = (T.x - me.x) * 1.5;
          if (Math.abs(wrap(towardWall - yaw)) < 0.2 || elapsed > 1500) setStage('in');
        } else if (T.stage === 'in') {
          wantYaw = towardWall;
          vx = s * (pocket ? 0.45 : 0.5);
          if (pocket) vz = Math.sin(now / 180) * 0.35; // wiggle so the pile breaks up
          const reached = depth < (T.stopDepth || 0.62);
          const stalled = elapsed > 700 && speed < 0.08;
          if (reached || stalled || elapsed > 2600) setStage(pocket ? 'dwell' : 'slide');
        } else if (T.stage === 'dwell') {
          wantYaw = towardWall;
          vx = s * 0.15; vz = Math.sin(now / 160) * 0.4;
          if (elapsed > 1300 || full) setStage('out');
        } else if (T.stage === 'slide') {
          wantYaw = towardWall;
          const dir = Math.sign(T.zEnd - T.z) || 1;
          vx = s * 0.22; vz = dir * P.sweepSpeed;
          const done = (me.z - T.zEnd) * dir > -0.15 || full || elapsed > 6000;
          if (speed > 0.12) T.movedAt = now;
          const blocked = !done && elapsed > 900 && now - (T.movedAt || T.ts) > 700; // stopped against something
          if (blocked) { MEM.stuck[cellOf(me.x, me.z + dir * 0.5)] += 1; B.note = 'Mistake: wall sweep blocked — remembering it'; }
          if (blocked && T.p0) T.p0 = { x: me.x, z: me.z };
          if (done || blocked) setStage('out');
        } else if (T.stage === 'out') {
          wantYaw = null;
          vx = -s * 0.7;
          if (elapsed > 650) {
            if (T.type === 'depot' && B.match && rawHop - (T.hopStart || 0) < 4) { B.match.depotFails++; B.note = 'Depot run not worth it — skipping the depot'; }
            B.task = null;
          }
        }
        if (T.stage === 'face' && T.hopStart == null) T.hopStart = rawHop;
      }
    }

    if (B.mode !== 'to-hub' && B.mode !== 'shooting on the move') B.nearGoal = false;
    if (B.taskActive) B.nearGoal = true; // pushing on purpose: don't call it stuck
    drive(vx, vz, wantYaw, yaw, sx);
    B.wantMove = Math.hypot(vx, vz) > 0.6;
    B.lastCmd = B.wantMove ? { x: vx, z: vz } : null;
  };

  // Menus. In a multiplayer room the bot only presses Ready (never Start, so friends aren't rushed).
  // In singleplayer it starts the next match itself so it keeps practising.
  const visibleButtons = () => [...document.querySelectorAll('button, [role="button"], a')]
    .filter((x) => !x.closest('#frsim-bot-host') && x.offsetParent !== null);
  let roomSniffAt = 0;
  // Expandable hoppers: a hopper "lid" that lifts on the "Robot special" key (X). Both 1678 and 5460 work this way
  // (the game's hint only names 1678), so it's read from each robot's own setup, plus any team the hint names.
  const hasLid = (c, team) => !!(c && c.hopper && c.hopper.net && c.hopper.net.part === 'lid' && c.hopper.net.lift) || lidTeams().has(team);
  // dumpers that don't show it in their setup (5460 is a dumper with a turret and an expandable hopper)
  const DUMPER_TEAMS = new Set([5460]);
  let LID_TEAMS = null;
  const lidTeams = () => {
    if (LID_TEAMS) return LID_TEAMS;
    const found = new Set();
    const scan = (v) => { if (Array.isArray(v)) for (const q of v) if (q && q.id === 'block' && typeof q.hint === 'string') for (const m of q.hint.matchAll(/(\d{2,5}):[^.]*?\blid\b/g)) found.add(+m[1]); };
    try { for (const L of EXPORTS) for (let i = 0; i < L.length; i++) { let v = L[i + 1]; if (v === 0) v = L[i + 2]; scan(v); } } catch (_) {}
    try { if (CACHE) for (const mod of CACHE.values()) { const ex = mod && mod.exports; if (ex && typeof ex === 'object') for (const k of Object.keys(ex)) scan(ex[k]); } } catch (_) {}
    if (found.size) LID_TEAMS = found; // (before the game has loaded, use what we know without caching it)
    return found.size ? found : new Set();
  };
  // the game's online-play store (rooms, chat, ping, and whether this is a ranked match)
  let ONLINE = null;
  const onlineState = () => {
    const ok = (v) => { try { const g = v && typeof v.getState === 'function' && v.getState(); return !!(g && 'ranked' in g && 'pingMs' in g && 'lobbies' in g); } catch (_) { return false; } };
    if (!ONLINE && CACHE) for (const mod of CACHE.values()) {
      const ex = mod && mod.exports; if (!ex || typeof ex !== 'object') continue;
      let keys; try { keys = Object.keys(ex); } catch (_) { continue; }
      for (const k of keys) { let v; try { v = ex[k]; } catch (_) { continue; } if (typeof v === 'function' && ok(v)) { ONLINE = v; break; } }
      if (ONLINE) break;
    }
    if (!ONLINE) for (const L of EXPORTS) { // the store is exported as a function (a hook with getState)
      for (let i = 0; i < L.length - 2; i++) if (typeof L[i] === 'string' && L[i + 1] === 0 && typeof L[i + 2] === 'function' && ok(L[i + 2])) { ONLINE = L[i + 2]; break; }
      if (ONLINE) break;
    }
    try { return ONLINE ? ONLINE.getState() : null; } catch (_) { return null; }
  };
  const sniffRoom = (now) => {
    if (now - roomSniffAt < 1500 || !document.body) return;
    roomSniffAt = now;
    const texts = visibleButtons().map((x) => (x.textContent || '').trim().toLowerCase());
    const inRoom = texts.some((t) => /^(ready|ready up|not ready|copy code|copy link|switch teams|watch instead|request host)$/.test(t));
    const inSolo = !inRoom && /single player/i.test((document.querySelector('h1,h2,h3,[class*="eyebrow"]') || {}).textContent || '') ||
      texts.includes('start match') && !texts.includes('switch teams');
    if (inRoom) B.multiplayer = true; else if (inSolo) B.multiplayer = false;
    // the game's own online store knows for sure whether we're in a room (singleplayer auto can then use the whole pile)
    { const st0 = onlineState(); if (st0 && 'room' in st0) B.multiplayer = !!st0.room; }
    // Ranked is against real people: the bot never drives there. The game's own online store says whether this
    // room came from the ranked queue (the on-screen text check is only a backup).
    const body = (document.body.innerText || '').slice(0, 4000);
    const st = onlineState();
    B.ranked = (st && st.ranked === true) ||
      texts.some((t) => /^(back to ranked|leave the ranked match\?|find a ranked match|ranked match)/.test(t)) || /\branked match\b/i.test(body);
    try { sessionStorage.setItem('frsimBot.mp', B.multiplayer ? '1' : '0'); } catch (_) {}
  };
  try { B.multiplayer = sessionStorage.getItem('frsimBot.mp') === '1'; } catch (_) { B.multiplayer = false; }

  let menuAt = 0;
  // New personal best: open the pause menu (Escape), press "Save replay", close the menu.
  const trySaveReplay = (now) => {
    const R = B.saveReplay; if (!R) return false;
    if (now > R.until) { B.saveReplay = null; B.note = 'Could not save the replay'; return false; }
    const btns = visibleButtons();
    const saved = btns.find((x) => /^replay saved/i.test((x.textContent || '').trim()));
    if (saved) {
      B.saveReplay = null; B.note = `New personal best ${R.score} — replay saved`;
      B.closeMenuUntil = now + 5000; // close the pause menu (the game stays paused while it's open)
      return true;
    }
    const save = btns.find((x) => /^save replay/i.test((x.textContent || '').trim()));
    if (save) { if (now - (R.clickAt || 0) > 800) { R.clickAt = now; save.click(); } return true; }
    if (now - (R.escAt || 0) > 1500 && R.tries < 8) { R.escAt = now; R.tries++; tapKey('Escape', now); } // open the pause menu
    return true;
  };
  const closePauseMenu = (now) => {
    if (!(now < (B.closeMenuUntil || 0))) return false;
    const resume = visibleButtons().find((x) => /^resume/i.test((x.textContent || '').trim()));
    if (!resume) { B.closeMenuUntil = 0; return false; } // closed
    if (now - (B.resumeAt || 0) > 600) { B.resumeAt = now; resume.click(); }
    return true;
  };
  const tryMenus = () => {
    if (!SETTINGS.enabled) return;
    const now = performance.now();
    if (closePauseMenu(now)) return;
    if (trySaveReplay(now)) return; // don't start the next match until the replay is saved
    if (now - menuAt < 2500) return;
    const buttons = visibleButtons();
    const find = (w) => buttons.find((x) => (x.textContent || '').trim().toLowerCase() === w);
    if (B.multiplayer) {
      const ready = SETTINGS.autoReady && (find('ready up') || find('ready'));
      if (ready) { menuAt = now; ready.click(); B.note = 'Readied up for the match'; }
      return;
    }
    if (!SETTINGS.autoReplay) return;
    if (B.match && B.lastPhase === 'settle') return; // let the last fuel land and the match be scored first
    for (const w of ['play again', 'start match']) {
      const b = find(w);
      if (b) { menuAt = now; b.click(); return; }
    }
  };

  // ---------------------------------------------------------------------------
  // 7. On-screen panel (lives in a shadow root so the game's CSS can't touch it)
  // ---------------------------------------------------------------------------
  const PHASE_LABEL = { auto: 'Auto', transition: 'Transition', shift1: 'Shift 1', shift2: 'Shift 2', shift3: 'Shift 3', shift4: 'Shift 4', endgame: 'Endgame', gap: 'Get ready', countdown: 'Countdown', pre: 'Pre-match', settle: 'Match over', done: 'Match over', post: 'Match over' };
  const MODE_LABEL = {
    collecting: ['Collecting fuel', 'go'], 'to-hub': ['Driving to hub', 'go'], shooting: ['Shooting', 'hot'],
    'waiting for hub': ['Waiting for hub', 'wait'], unsticking: ['Getting unstuck', 'bad'], 'no fuel in reach': ['Looking for fuel', 'wait'],
    passing: ['Passing to our zone', 'hot'], 'to pass point': ['Heading out to pass', 'go'],
    'sweeping wall': ['Cleaning back wall', 'go'], 'clearing depot': ['Emptying depot', 'go'],
    'clearing tower': ['Cleaning by the tower', 'go'], 'shooting on the move': ['Shooting on the move', 'hot'],
    defending: ['Defending', 'bad'], 'blocking shots': ['Blocking shots', 'bad'], shoving: ['Shoving shooter', 'bad'],
    'backing off': ['Backing off (no pin)', 'wait'], containing: ['Keeping them in their zone', 'bad'],
    'pushing back': ['Pushing them back', 'bad'],
    'escaping pin': ['Pinned — sliding out', 'bad'], 'bump defense': ['Ramming at the lane', 'bad'], 'guarding bump': ['Guarding the bump', 'bad'],
    'guarding trench': ['Guarding the trench', 'bad'], 'copying a pro run': ['Copying a pro’s run', 'go'], 'holding (full)': ['Full — waiting to head back', 'wait'], 'clearing intake jam': ['Clearing intake jam', 'wait'], 'auto swipe': ['Auto swipe', 'go'], 'to the depot': ['Auto: to the depot', 'go'], 'releasing pin': ['Releasing pin (2 m back)', 'wait'],
    off: ['Autopilot off', 'off'], 'waiting for a match': ['Waiting for a match', 'off'],
    'looking for the game': ['Looking for the game…', 'wait'], 'off in ranked': ['Off — Ranked is against real people', 'off'],
  };
  const BAR_PHASES = ['auto', ...SHIFT_PHASES];
  const BAR_SHORT = { auto: 'A', transition: 'T', shift1: 'S1', shift2: 'S2', shift3: 'S3', shift4: 'S4', endgame: 'EG' };

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .card{--bg:#0e1320f2;--panel:#161d2e;--line:#26314a;--text:#e9eef8;--muted:#8d9ab3;--accent:#4c8dff;--good:#34d399;--warn:#fbbf24;--bad:#f87171;
      position:fixed;z-index:2147483647;width:316px;color:var(--text);background:var(--bg);
      border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 50px #0009,0 0 0 1px #ffffff08 inset;
      font:12.5px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;backdrop-filter:blur(10px);
      user-select:none;overflow:hidden;transition:width .2s;display:flex;flex-direction:column;max-height:min(calc(100vh - 88px), 80vh)}
    .card.red{--accent:#ff5d6c}
    .head{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;background:linear-gradient(180deg,#ffffff08,transparent);border-bottom:1px solid var(--line)}
    .head:active{cursor:grabbing}
    .logo{width:22px;height:22px;border-radius:7px;background:var(--accent);display:grid;place-items:center;box-shadow:0 0 14px color-mix(in srgb,var(--accent) 60%,transparent)}
    .logo svg{width:14px;height:14px}
    .title{font-weight:700;letter-spacing:.2px;font-size:13px}
    .team{font-size:11px;color:var(--muted);margin-left:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
    .sp{flex:1}
    .icon{all:unset;cursor:pointer;width:24px;height:24px;display:grid;place-items:center;border-radius:7px;color:var(--muted)}
    .icon:hover{background:#ffffff12;color:var(--text)}
    .body{padding:12px;display:grid;gap:10px;overflow-y:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#33405c transparent}
    .row{display:flex;align-items:center;gap:8px}
    .switch{all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:12px;background:var(--panel);border:1px solid var(--line)}
    .switch:hover{border-color:#3a4766}
    .knob{width:38px;height:22px;border-radius:99px;background:#33405c;position:relative;transition:background .2s;flex:none}
    .knob::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px #0006}
    .on .knob{background:var(--good)} .on .knob::after{transform:translateX(16px)}
    .sw-text b{display:block;font-size:13px} .sw-text span{color:var(--muted);font-size:11px}
    kbd{font:600 10.5px ui-monospace,monospace;padding:1px 5px;border-radius:4px;border:1px solid var(--line);background:#0b0f19;color:var(--text)}
    .live{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:stretch}
    .box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:9px 10px}
    .lbl{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
    .phase{font-weight:700;font-size:14px;margin-top:1px}
    .clock{font:700 26px/1 ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums;text-align:right}
    .clock small{display:block;font:500 10.5px system-ui;color:var(--muted);margin-top:4px;text-align:right}
    .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:99px;font-weight:600;font-size:11.5px;background:#ffffff10;color:var(--muted)}
    .pill i{width:7px;height:7px;border-radius:50%;background:currentColor}
    .pill.go{color:#93c5fd;background:#3b82f622} .pill.hot{color:var(--good);background:#10b98122}
    .pill.wait{color:var(--warn);background:#f59e0b22} .pill.bad{color:var(--bad);background:#ef444422}
    .pill.hot i,.pill.go i{animation:pulse 1.2s infinite}
    @keyframes pulse{50%{opacity:.35}}
    .meter{height:8px;border-radius:99px;background:#0b0f19;overflow:hidden;border:1px solid var(--line)}
    .meter>div{height:100%;background:linear-gradient(90deg,#facc15,#f59e0b);border-radius:99px;transition:width .25s}
    .spread{display:flex;justify-content:space-between;align-items:baseline}
    .num{font-variant-numeric:tabular-nums;font-weight:600}
    .big{font:800 24px/1 system-ui;font-variant-numeric:tabular-nums}
    .bars{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;align-items:end;height:58px;margin-top:6px}
    .bar{display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;justify-content:flex-end}
    .bar div{width:100%;border-radius:4px 4px 2px 2px;background:#2b3854;min-height:3px;transition:height .3s}
    .bar.cur div{background:var(--accent)} .bar.done div{background:color-mix(in srgb,var(--accent) 55%,#2b3854)}
    .bar span{font-size:9.5px;color:var(--muted)} .bar em{font-style:normal;font-size:9.5px;color:var(--text);font-variant-numeric:tabular-nums}
    svg.spark{width:100%;height:46px;display:block;margin-top:6px}
    .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
    .chip{font-size:10.5px;padding:2px 7px;border-radius:99px;background:#ffffff0d;border:1px solid var(--line);color:var(--muted)}
    .chip.new{color:#c4b5fd;border-color:#7c3aed66;background:#7c3aed1a}
    details{background:var(--panel);border:1px solid var(--line);border-radius:12px}
    summary{cursor:pointer;padding:9px 10px;list-style:none;display:flex;justify-content:space-between;color:var(--muted);font-weight:600}
    summary::-webkit-details-marker{display:none}
    summary::after{content:"▾";transition:transform .2s} details[open] summary::after{transform:rotate(180deg)}
    .params{padding:0 10px 10px;display:grid;gap:8px}
    .param .track{position:relative;height:6px;border-radius:99px;background:#0b0f19;border:1px solid var(--line);margin-top:4px}
    .param .fill{position:absolute;inset:0 auto 0 0;border-radius:99px;background:color-mix(in srgb,var(--accent) 70%,transparent)}
    .param .try{position:absolute;top:-3px;width:3px;height:10px;border-radius:2px;background:#c4b5fd;transform:translateX(-1px)}
    .opts{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .mini{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:10px;background:var(--panel);border:1px solid var(--line);font-size:11.5px}
    .mini .knob{width:28px;height:16px}.mini .knob::after{width:12px;height:12px;top:2px;left:2px}.mini.on .knob::after{transform:translateX(12px)}
    .btns{display:flex;gap:6px}
    .pros .btn{padding:8px 0}
    .drop{margin-top:7px;padding:6px;border:1px dashed var(--line);border-radius:9px;text-align:center;color:var(--muted);font-size:11px}
    .btn.hs{display:block;flex:none;width:100%;box-sizing:border-box}
    .btn.hs.new{border-color:var(--good);color:var(--good)}
    .btn{all:unset;cursor:pointer;flex:1;text-align:center;padding:7px 0;border-radius:9px;background:#ffffff0b;border:1px solid var(--line);font-weight:600;font-size:11.5px}
    .btn:hover{background:#ffffff16} .btn.danger{color:var(--bad)}
    .toast{position:absolute;left:12px;right:12px;bottom:12px;padding:8px 10px;border-radius:10px;font-weight:600;font-size:11.5px;
      background:#1f2a40;border:1px solid var(--line);box-shadow:0 8px 24px #0008;transform:translateY(140%);opacity:0;transition:.25s}
    .toast.show{transform:none;opacity:1} .toast.bad{border-color:#ef444466;color:#fecaca} .toast.good{border-color:#10b98166;color:#bbf7d0}
    .card.min{width:auto} .card.min .body,.card.min .team{display:none}
    .minline{display:none;gap:8px;align-items:center} .card.min .minline{display:flex}
    .empty{color:var(--muted);font-size:11.5px;text-align:center;padding:8px 0}
  `;

  const ICON_BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>';
  let host, root, card, els = {}, lastToast = '';

  const buildPanel = () => {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.id = 'frsim-bot-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="card" part="card">
        <div class="head" data-drag>
          <div class="logo">${ICON_BOT}</div>
          <div class="title">Rebuilt Bot</div>
          <div class="team" data-e="team"></div>
          <div class="minline"><span class="pill" data-e="minpill"><i></i><span></span></span><span class="num" data-e="minscore"></span></div>
          <div class="sp"></div>
          <button class="icon" data-a="min" title="Minimise">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
        <div class="body">
          <button class="switch" data-a="toggle">
            <div class="knob"></div>
            <div class="sw-text"><b data-e="swtitle">Autopilot</b><span>Press <kbd>\`</kbd> anytime to take over</span></div>
          </button>

          <div class="live">
            <div class="box">
              <div class="lbl">Now</div>
              <div class="phase" data-e="phase">Waiting for a match</div>
              <div class="lbl" data-e="robots" style="text-transform:none;letter-spacing:0;margin-top:2px"></div>
              <div class="row" style="margin-top:6px;flex-wrap:wrap">
                <span class="pill" data-e="mode"><i></i><span></span></span>
                <span class="pill" data-e="hub"><i></i><span></span></span>
              </div>
            </div>
            <div class="box" style="min-width:86px;display:flex;flex-direction:column;justify-content:center">
              <div class="clock" data-e="clock">--<small>left in phase</small></div>
            </div>
          </div>

          <div class="box pros">
            <div class="spread"><span class="lbl">Learn from the pros</span><span class="muted" style="color:var(--muted)" data-e="prosmeta"></span></div>
            <div class="btns" style="margin-top:7px">
              <button class="btn" data-a="learnboard" title="Download and study the best shared leaderboard runs for the robot you're driving">Leaderboard</button>
              <button class="btn" data-a="learnfile" title="Pick one or more .frcreplay files, e.g. leaderboard runs you downloaded">Upload replays</button>
              <button class="btn" data-a="learnsaved" title="Study the replays saved in this browser (yours and the bot's personal bests) for the robot you're driving">Saved</button>
            </div>
            <div class="drop">…or drop .frcreplay files anywhere on this panel</div>
          </div>

          <button class="btn hs" data-a="posths" title="Opens a ready-filled GitHub issue with your best score; press Submit there to post it">🏆 Post high score to GitHub</button>

          <div class="box">
            <div class="spread"><span class="lbl">Hopper</span><span class="num" data-e="hoptext">0 / 0</span></div>
            <div class="meter" style="margin-top:6px"><div data-e="hop" style="width:0%"></div></div>
          </div>

          <div class="box">
            <div class="spread"><span class="lbl" data-e="scorelbl">Our score</span><span class="big" data-e="score">0</span></div>
            <div class="bars" data-e="bars">${BAR_PHASES.map((p) => `<div class="bar" data-p="${p}"><em>0</em><div style="height:3px"></div><span>${BAR_SHORT[p]}</span></div>`).join('')}</div>
          </div>

          <div class="box">
            <div class="spread"><span class="lbl">Learning</span><span class="muted" style="color:var(--muted)" data-e="learnmeta"></span></div>
            <svg class="spark" data-e="spark" viewBox="0 0 280 46" preserveAspectRatio="none"></svg>
            <div class="chips" data-e="trying"></div>
          </div>

          <details data-e="brain">
            <summary>What it has learned</summary>
            <div class="params" data-e="params"></div>
          </details>

          <div class="opts">
            <button class="mini" data-a="replay"><div class="knob"></div>Auto-replay</button>
            <button class="mini" data-a="explore"><div class="knob"></div>Try new ideas</button>
            <button class="mini" data-a="defense" title="Only in multiplayer, and only while our hub is off"><div class="knob"></div>Defense (MP)</button>
            <button class="mini" data-a="ready" title="Press Ready in multiplayer rooms"><div class="knob"></div>Auto ready-up</button>
            <button class="mini" data-a="defonly" title="Multiplayer: play only defense all teleop, keeping them in their zone"><div class="knob"></div>Defense only (MP)</button>
            <button class="mini" data-a="bumponly" title="Multiplayer: spend all teleop guarding the two bumps and ramming anyone crossing"><div class="knob"></div>Bump defense only (MP)</button>
            <button class="mini" data-a="copypros" title="Singleplayer: replay the best learned run for this robot 1:1 — same path, same heading, shooting, passing and intaking when they did. Learn from the leaderboard or a replay file first."><div class="knob"></div>Copy the pros (1:1)</button>
          </div>
          <div class="btns">
            <button class="btn" data-a="export">Export brain</button>
            <button class="btn" data-a="import">Import</button>
            <button class="btn danger" data-a="reset">Reset</button>
          </div>
        </div>
        <div class="toast" data-e="toast"></div>
      </div>`;
    document.body.appendChild(host);
    card = root.querySelector('.card');
    root.querySelectorAll('[data-e]').forEach((n) => { els[n.dataset.e] = n; });
    root.querySelectorAll('[data-a]').forEach((n) => { els['a_' + n.dataset.a] = n; });

    // position + drag
    const pos = SETTINGS.pos || { left: null, top: null };
    const place = (l, t) => {
      const w = card.offsetWidth, h = card.offsetHeight;
      l = clamp(l, 4, innerWidth - w - 4); t = clamp(t, 4, innerHeight - h - 4);
      card.style.left = l + 'px'; card.style.top = t + 'px'; card.style.bottom = 'auto'; card.style.right = 'auto';
      return { left: l, top: t };
    };
    // default: top-right, clear of the game's setup menus and the scoreboard
    if (pos.top != null) place(pos.left, pos.top); else { card.style.right = '16px'; card.style.top = '72px'; }
    const head = root.querySelector('[data-drag]');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = card.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => { SETTINGS.pos = place(ev.clientX - ox, ev.clientY - oy); };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); saveSettings(); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
    });
    addEventListener('resize', () => { const r = card.getBoundingClientRect(); if (SETTINGS.pos && SETTINGS.pos.top != null) place(r.left, r.top); });

    // stop clicks/keys inside the panel from reaching the game
    for (const ev of ['keydown', 'keyup', 'pointerdown', 'mousedown', 'click', 'wheel']) host.addEventListener(ev, (e) => e.stopPropagation());

    // learning from uploaded / saved replays: pick the best runs for this robot, learn their numbers and spots
    const finishLearning = (results, team) => {
      let pool = team != null ? results.filter((r) => r.team === team) : results;
      if (!pool.length) pool = results;
      if (!pool.length) { toast('No replay could be read', 'bad'); return; }
      pool.sort((x, y) => y.score - x.score);
      const top = pool.slice(0, 3), avg = { team: top[0].team, score: top[0].score, params: {} };
      for (const k of KEYS) { const vals = top.map((r) => r.params[k]).filter((x) => x != null); if (vals.length) avg.params[k] = vals.reduce((a2, b2) => a2 + b2, 0) / vals.length; }
      avg.copies = top.filter((r) => r.copy).map((r) => ({ who: `${r.team} (${r.score})`, score: r.score, copy: r.copy }));
      const n = applyReplayLesson(avg, 0.65, team != null ? team : avg.team);
      B.note = n ? 'Learned from replay — ' + describeLesson(avg) : 'Nothing clear to learn from that replay';
      toast(n ? `Learned from ${top.length} replay${top.length > 1 ? 's' : ''}` : 'Nothing clear to learn', n ? 'good' : 'bad');
      safePanel();
    };
    const learnFromFiles = (files, team) => {
      const list = [...(files || [])];
      if (!list.length) return;
      toast(`Studying ${list.length} replay${list.length > 1 ? 's' : ''}…`);
      Promise.all(list.map((f) => f.arrayBuffer().then((b) => new Uint8Array(b))))
        .then((bufs) => learnFromBytesList(bufs, team)).then((res) => finishLearning(res, team))
        .catch((e) => toast('Could not read that replay: ' + e.message, 'bad'));
    };
    // drag and drop replay files onto the panel
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.outline = '2px dashed var(--accent)'; });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', (e) => {
      e.preventDefault(); card.style.outline = '';
      const v = GAME && GAME.view, me = v && myRobot(GAME, v);
      learnFromFiles(e.dataTransfer && e.dataTransfer.files, me ? me.team : null);
    });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-a]'); if (!btn) return;
      const a = btn.dataset.a;
      if (a === 'toggle') setEnabled(!SETTINGS.enabled);
      if (a === 'replay') { SETTINGS.autoReplay = !SETTINGS.autoReplay; saveSettings(); }
      if (a === 'explore') { SETTINGS.explore = !SETTINGS.explore; saveSettings(); }
      if (a === 'defense') { SETTINGS.defense = !SETTINGS.defense; saveSettings(); }
      if (a === 'ready') { SETTINGS.autoReady = !SETTINGS.autoReady; saveSettings(); }
      if (a === 'defonly') { SETTINGS.defenseOnly = !SETTINGS.defenseOnly; if (SETTINGS.defenseOnly) SETTINGS.bumpOnly = false; saveSettings(); }
      if (a === 'learnboard') {
        const v = GAME && GAME.view, me = v && myRobot(GAME, v);
        const team = me ? me.team : null;
        if (team == null) { toast('Pick your robot (start a match) first, then learn from the leaderboard', 'bad'); return; }
        toast('Fetching the leaderboard…');
        learnFromLeaderboard(team, (msg) => toast(msg)).then(({ results, how }) => {
          const avg = { team: results[0].team, score: results[0].score, params: {} };
          for (const k of KEYS) { const vals = results.map((r) => r.params[k]).filter((x) => x != null); if (vals.length) avg.params[k] = vals.reduce((a2, b2) => a2 + b2, 0) / vals.length; }
          avg.copies = results.filter((r) => r.copy).map((r) => ({ who: `${r.by || r.team} (${r.points || r.score})`, score: r.points || r.score, copy: r.copy }));
          const n = applyReplayLesson(avg, 0.65, team);
          const who = results.map((r) => `${r.by || r.team} ${r.points || r.score}`).join(', ');
          B.note = n ? `Learned from ${how} (${who}) — ` + describeLesson(avg) : 'Nothing clear to learn from those runs';
          toast(n ? `Learned ${n} settings from ${results.length} leaderboard run${results.length > 1 ? 's' : ''}` : 'Nothing clear to learn', n ? 'good' : 'bad');
          safePanel();
        }).catch((e) => toast('Leaderboard learning failed: ' + e.message, 'bad'));
      }
      if (a === 'learnsaved' || a === 'learnfile') {
        const v = GAME && GAME.view, me = v && myRobot(GAME, v);
        const team = me ? me.team : null;
        const finish = (results) => finishLearning(results, team);
        if (a === 'learnsaved') {
          toast('Studying saved replays…');
          readSavedReplays().then((list) => learnFromBytesList(list, team)).then(finish).catch((e) => toast('Could not read the saved replays: ' + e.message, 'bad'));
        } else {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.frcreplay,application/octet-stream'; inp.multiple = true;
          inp.onchange = () => learnFromFiles(inp.files, team);
          inp.click();
        }
      }
      if (a === 'posths') postHighScore();
      if (a === 'copypros') {
        SETTINGS.replicatePros = !SETTINGS.replicatePros; saveSettings();
        const v0 = GAME && GAME.view, me0 = v0 && myRobot(GAME, v0), C0 = me0 && MEM.copy && MEM.copy[me0.team];
        toast(!SETTINGS.replicatePros ? 'Copy the pros off — playing its own way' : C0 && C0.track ? `Copying ${C0.trackBy || 'the best run'} 1:1 (singleplayer)` : 'On — now learn from the leaderboard (or a replay file) so it has a run to copy', 'good');
      }
      if (a === 'bumponly') { SETTINGS.bumpOnly = !SETTINGS.bumpOnly; if (SETTINGS.bumpOnly) SETTINGS.defenseOnly = false; saveSettings(); }
      if (a === 'min') { SETTINGS.panelOpen = !SETTINGS.panelOpen; saveSettings(); }
      if (a === 'reset' && confirm('Forget everything the bot has learned?')) { MEM = defaultMemory(); saveMem(); toast('Learning reset — starting fresh', 'good'); }
      if (a === 'export') {
        const blob = new Blob([JSON.stringify(MEM)], { type: 'application/json' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'frsim-bot-brain.json'; link.click();
        toast('Brain exported', 'good');
      }
      if (a === 'import') {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
        inp.onchange = () => inp.files[0] && inp.files[0].text().then((t) => {
          try { const m = JSON.parse(t); if (!m.best) throw 0; localStorage.setItem(STORE, JSON.stringify(m)); loadMem(); toast('Brain imported', 'good'); }
          catch (_) { toast('That file is not a bot brain', 'bad'); }
        });
        inp.click();
      }
      safePanel();
    });
    safePanel();
  };

  // Post the bot's high score: opens a ready-filled issue on the bot's GitHub page (your own GitHub login
  // posts it when you press Submit there; the script never holds a GitHub password or token).
  const GITHUB_REPO = 'tdizzy56/FRSIM-ai-by-claude';
  const MODE_NAME = { solo: 'Singleplayer', mp: 'Multiplayer', def: 'Defense only', bump: 'Bump defense only' };
  const postHighScore = () => {
    const all = Object.entries(MEM.pb || {}).map(([k, v]) => { const [team, mode] = k.split(':'); return { team: +team, mode, score: Math.round(v) }; })
      .filter((e) => e.score > 0).sort((x, y) => y.score - x.score);
    if (!all.length) { toast('No high score yet — finish a match first', 'bad'); return; }
    const v = GAME && GAME.view, me = v && myRobot(GAME, v);
    const top = (me && all.find((e) => e.team === me.team)) || all[0];
    const mode = (m) => MODE_NAME[m] || m;
    const title = `High score: ${top.score} pts with ${top.team} (${mode(top.mode)}) — bot v${VERSION}`;
    const body = [
      `**Score:** ${top.score}`, `**Robot:** ${top.team} (${archOf(top.team)})`, `**Mode:** ${mode(top.mode)}`,
      `**Bot version:** ${VERSION}`, `**Matches played:** ${MEM.history.length}`, `**Date:** ${new Date().toISOString().slice(0, 10)}`,
      '', 'All personal bests:', '', '| Robot | Mode | Score |', '| --- | --- | --- |',
      ...all.slice(0, 20).map((e) => `| ${e.team} | ${mode(e.mode)} | ${e.score} |`),
    ].join('\n');
    const url = `https://github.com/${GITHUB_REPO}/issues/new?labels=high-score&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    const w = window.open(url, '_blank', 'noopener');
    MEM.pbPosted = { ...(MEM.pbPosted || {}), [`${top.team}:${top.mode}`]: top.score }; saveMem();
    toast(w === null ? 'Pop-up blocked — allow pop-ups for this site, then try again' : 'GitHub opened — press Submit there to post it', w === null ? 'bad' : 'good');
  };

  let toastTimer = 0;
  const toast = (msg, kind) => {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.className = 'toast ' + (kind || ''); }, 4200);
  };

  const setEnabled = (on) => {
    SETTINGS.enabled = on; saveSettings();
    if (!on) releaseAll();
    toast(on ? 'Autopilot engaged' : 'Autopilot off — you have control', on ? 'good' : '');
    try { renderPanel(); } catch (e) { console.error("[FRSim bot] panel", e); }
  };

  const setPill = (el, text, kind) => {
    el.className = 'pill ' + (kind || '');
    el.lastElementChild.textContent = text;
  };

  const renderPanel = () => {
    if (!card) return;
    const view = GAME && GAME.view;
    const robot = myRobot(GAME, view);
    const m = B.match;
    const inMatch = !!(view && view.phase && PLAY_PHASES.includes(view.phase));

    card.classList.toggle('min', !SETTINGS.panelOpen);
    card.classList.toggle('red', !!(robot && robot.alliance === 'red'));
    els.a_toggle.classList.toggle('on', SETTINGS.enabled);
    els.swtitle.textContent = SETTINGS.enabled ? 'Autopilot on' : 'Autopilot off';
    els.a_replay.classList.toggle('on', SETTINGS.autoReplay);
    els.a_explore.classList.toggle('on', SETTINGS.explore);
    els.a_defense.classList.toggle('on', SETTINGS.defense);
    els.a_ready.classList.toggle('on', SETTINGS.autoReady);
    els.a_defonly.classList.toggle('on', SETTINGS.defenseOnly);
    els.a_bumponly.classList.toggle('on', SETTINGS.bumpOnly);
    els.a_copypros.classList.toggle('on', !!SETTINGS.replicatePros);

    const cfg = robot && findRobotConfig(robot.team);
    const kind = B.info ? [B.info.turret && 'turret', B.info.blocker && 'blocker'].filter(Boolean).join(', ') : '';
    els.team.textContent = robot ? `${robot.team}${cfg && cfg.name ? ' · ' + cfg.name : ''}${kind ? ' · ' + kind : ''}${B.multiplayer ? ' · MP' : ''}` : '';

    // now
    els.phase.textContent = (view && PHASE_LABEL[view.phase]) || (view && view.phase) || 'Waiting for a match';
    const clk = view && typeof view.clock === 'number' ? Math.max(0, Math.ceil(view.clock)) : null;
    els.clock.firstChild.nodeValue = clk == null ? '--' : `${Math.floor(clk / 60)}:${String(clk % 60).padStart(2, '0')}`;
    const ml = SETTINGS.enabled ? (MODE_LABEL[B.mode] || [B.mode ? B.mode[0].toUpperCase() + B.mode.slice(1) : 'Idle', 'off']) : MODE_LABEL.off;
    setPill(els.mode, ml[0], ml[1]);
    setPill(els.minpill, ml[0], ml[1]);
    if (robot && inMatch) {
      const t = ourHubTiming(view, robot);
      if (t.active) setPill(els.hub, t.untilInactive < 99 ? `Hub on · ${Math.ceil(t.untilInactive)}s` : 'Hub on', 'hot');
      else setPill(els.hub, t.untilActive < 99 ? `Hub off · on in ${Math.ceil(t.untilActive)}s` : 'Hub off', 'wait');
      els.hub.style.display = '';
    } else els.hub.style.display = 'none';

    // hopper
    const hop = robot ? robot.hopperFuel || 0 : 0, cap = robot ? robot.hopperCapacity || 0 : 0;
    const jam = B.fuel && B.fuel.jam ? B.fuel.jam : 0;
    els.hoptext.textContent = `${hop} / ${cap}${jam ? ` · ${jam} jammed` : ''}${B.fuel && B.fuel.full ? ' · full' : ''}`;
    els.hop.style.width = cap ? Math.min(100, (hop / cap) * 100) + '%' : '0%';

    // per-phase points
    const gains = m ? m.phaseGain : (MEM.history.length ? Object.fromEntries([['auto', MEM.history.at(-1).auto], ...SHIFT_PHASES.map((p, i) => [p, MEM.history.at(-1).perShift[i]])]) : {});
    const total = BAR_PHASES.reduce((a, p) => a + (gains[p] || 0), 0);
    // the game's own score for our alliance (matches the scoreboard); bars = our fuel points by phase
    const scNow = view && view.score && robot && view.score[robot.alliance];
    els.score.textContent = scNow && typeof scNow.total === 'number' ? scNow.total : total;
    if (els.scorelbl) els.scorelbl.textContent = scNow ? (B.robotsSeen ? 'Alliance score' : 'Our score') + ` · fuel ${total}` : 'Last match · fuel';
    els.minscore.textContent = total ? `${total} pts` : '';
    const maxG = Math.max(10, ...BAR_PHASES.map((p) => gains[p] || 0));
    const curIdx = view ? BAR_PHASES.indexOf(view.phase) : -1;
    els.bars.querySelectorAll('.bar').forEach((b, i) => {
      const g = gains[b.dataset.p] || 0;
      b.querySelector('div').style.height = Math.max(3, (g / maxG) * 44) + 'px';
      b.querySelector('em').textContent = g;
      b.className = 'bar' + (i === curIdx ? ' cur' : (curIdx > i || !m ? ' done' : ''));
    });

    // learning sparkline
    const mk = modeKey(), LSP = robot ? robotSlot(mk, robot.team) : slot(mk);
    const sameMode = (h) => !!h.mp === !!B.multiplayer && !!h.bump === (mk === 'bump') && !!h.def === (mk === 'def' || mk === 'bump') &&
      (!robot || h.team === robot.team);
    const nMode = MEM.history.filter(sameMode).length;
    const modeName = (mk === 'bump' ? 'Bump defense only' : mk === 'def' ? 'Defense only' : B.multiplayer ? 'Multiplayer' : 'Solo') +
      (robot ? ` · ${robot.team} (${archOf(robot.team)})` : '');
    const H = MEM.history.filter(sameMode).slice(-30);
    const dup = OTHER_COPY || window.__frsimBot !== ME;
    if (els.robots) {
      els.robots.textContent = dup ? `⚠ Two copies of the bot are running (${OTHER_COPY || window.__frsimBot.version || 'older'} and ${VERSION}). Turn the old one off in Violentmonkey.` :
        B.robotsSeen ? `${B.robotsSeen} other robot${B.robotsSeen > 1 ? 's' : ''} on field` +
          (B.match && (B.match.pinnedEvents || B.match.pinsReleased) ? ` · pinned ${B.match.pinnedEvents}× · let go ${B.match.pinsReleased}×` : '') : '';
      els.robots.style.color = dup ? 'var(--bad)' : '';
    }
    const pbv = MEM.pb && robot ? MEM.pb[`${robot.team}:${mk}`] : null;
    if (els.a_posths) {
      const unposted = Object.entries(MEM.pb || {}).some(([k, v]) => v > ((MEM.pbPosted || {})[k] || 0));
      els.a_posths.classList.toggle('new', unposted);
    }
    const cp = MEM.copy && robot ? MEM.copy[robot.team] : null;
    els.learnmeta.title = cp ? 'Copying: ' + cp.from.join(', ') : '';
    if (els.prosmeta) els.prosmeta.textContent = cp ? `learned ${cp.from.length} run${cp.from.length === 1 ? '' : 's'}${cp.track ? ' · 1:1 ready' : ''}` : robot ? 'not yet for ' + robot.team : '';
    // "best match" only changes when a match beats it; "plan avg" is how the current plan has been scoring lately
    const replaying = SETTINGS.replicatePros && !B.multiplayer && cp && cp.track;
    els.learnmeta.textContent = (replaying ? `📼 replaying ${cp.trackBy || 'a pro'} 1:1 · ` : cp ? '📼 learned from pros · ' : '') + (nMode
      ? `${modeName} · ${nMode} match${nMode === 1 ? '' : 'es'} · best match ${pbv ? Math.round(pbv) : '–'} · plan avg ${LSP.best.avg == null ? '–' : Math.round(LSP.best.avg)}`
      : `${modeName} · no matches yet`);
    els.learnmeta.title = (els.learnmeta.title ? els.learnmeta.title + '\n' : '') + 'Best match: your highest score with this robot in this mode. Plan avg: what the plan the bot is using has been scoring lately (it moves after every match).';
    if (H.length) {
      const W = 280, Hh = 46, pad = 4;
      const vals = H.map((h) => h.reward);
      const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals, LSP.best.avg || 0);
      const X = (i) => (H.length === 1 ? W / 2 : pad + (i / (H.length - 1)) * (W - 2 * pad));
      const Y = (v) => Hh - pad - ((v - lo) / (hi - lo || 1)) * (Hh - 2 * pad);
      const line = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      const area = `${line}L${X(vals.length - 1)},${Hh}L${X(0)},${Hh}Z`;
      const bestY = LSP.best.avg == null ? null : Y(LSP.best.avg);
      els.spark.innerHTML = `
        <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
        ${bestY != null ? `<line x1="0" x2="${W}" y1="${bestY}" y2="${bestY}" stroke="#34d399" stroke-width="1" stroke-dasharray="3 3" opacity=".7"><title>Plan average</title></line>` : ''}
        <path d="${area}" fill="url(#g)"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
        ${H.map((h, i) => h.accepted ? `<circle cx="${X(i)}" cy="${Y(h.reward)}" r="3" fill="#34d399"/>` : '').join('')}`;
    } else {
      els.spark.innerHTML = `<text x="140" y="27" text-anchor="middle" fill="#8d9ab3" font-size="11">Finish a match to see progress</text>`;
    }
    els.trying.innerHTML = !m ? '' : m.trial ? `<span class="chip new">Trying the strategy from ${m.trial}</span>` : m.replay
      ? '<span class="chip">Replaying the current plan to double-check it</span>'
      : (m.changed.length
        ? `<span class="chip new" title="${m.changed.map((k) => PARAMS[k].label).join(', ')}">Trying ${m.changed.length} tweak${m.changed.length > 1 ? 's' : ''}: ${m.changed.map((k) => PARAMS[k].short).join(', ')}</span>`
        : '<span class="chip">Same plan as last time</span>');

    // brain
    if (els.brain.open || !els.params.childElementCount) {
      els.params.innerHTML = KEYS.map((k) => {
        const d = PARAMS[k], v = LSP.best.p[k], frac = (v - d.min) / (d.max - d.min);
        const tv = m && m.changed.includes(k) ? (m.P[k] - d.min) / (d.max - d.min) : null;
        return `<div class="param"><div class="spread"><span>${d.label}</span><span class="num">${v.toFixed(d.max - d.min > 20 ? 0 : 2)}</span></div>
          <div class="track"><div class="fill" style="width:${(frac * 100).toFixed(1)}%"></div>${tv != null ? `<div class="try" style="left:${(tv * 100).toFixed(1)}%" title="Trying this match"></div>` : ''}</div></div>`;
      }).join('');
    }

    // toasts for notes (mistakes, match results)
    if (B.note && B.note !== lastToast) {
      lastToast = B.note;
      toast(B.note, /^Mistake/.test(B.note) ? 'bad' : /new best|personal best/i.test(B.note) ? 'good' : '');
    }
    if (!B.note) lastToast = '';
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote' && e.isTrusted) { e.preventDefault(); e.stopPropagation(); setEnabled(!SETTINGS.enabled); }
  }, true);
  window.addEventListener('blur', () => releaseAll());

  // handy for debugging from the console
  window.__frsimBot = { version: VERSION, B, get MEM() { return MEM; }, findGame, findRobotConfig, analyzeReplay, readSavedReplays, describeLesson, learnFromLeaderboard, applyReplayLesson, findReplayLib, findBoardLib, onlineState,
    get hooked() { return { early: EXPORTS.length, cache: !!CACHE }; } };
  const ME = window.__frsimBot;
  // Driving starts first and never depends on the panel: a panel problem can't stop the bot.
  const safePanel = () => { try { renderPanel(); } catch (e) { console.error('[FRSim bot] panel', e); } };
  const boot = () => {
    setInterval(() => { try { tick(); } catch (e) { console.error('[FRSim bot]', e); releaseAll(); } }, 33);
    try { buildPanel(); } catch (e) { console.error('[FRSim bot] panel', e); }
    setInterval(safePanel, 250);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
