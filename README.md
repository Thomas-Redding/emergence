# Emergence

A top-down 2D survival sandbox in plain JavaScript and Canvas. A procedurally generated world of forests and plains, deer to hunt, and humans (AI or real players) who turn sticks into spears, sneak up on deer, build fires, cook the meat and eat it.

The point of the project is a **deterministic simulation with black-boxed AI**: you can write completely different NPC brains, run them against the same seed, and compare how they do.

## Run it

You need Node (for tests) and Python 3 (to serve the files). There are no dependencies to install.

```bash
npm run serve        # serves on http://localhost:8000
npm test             # runs the whole test suite (node:test)
```

Open `http://localhost:8000/?seed=1` (any integer seed works).

| URL | What you get |
|---|---|
| `/?seed=7` | play as a human alongside three baseline NPCs |
| `/?seed=7&observer` | no player: a god's-eye view of the NPCs (the **Observe / Play** button switches; it restarts the game) |

### Controls

| Key | Action |
|---|---|
| WASD / arrows | move (hold two for diagonals). With no character (observer mode, or after you die) they pan the camera instead; Shift pans faster |
| Shift + move | sneak (slow and quiet) |
| I J K L | turn to look without moving |
| E | pick up the nearest item in reach |
| hold Q | sharpen a held stick into a spear (200 ticks) |
| X | stab the nearest deer (needs a spear, and you must be facing it) |
| R | make a fire from two held sticks |
| hold T | tend an unlit fire until it catches |
| hold C | cook raw meat at a lit fire |
| G | eat cooked meat |
| wheel / `+` `-` | zoom |
| drag | pan (turns off follow) |
| F | toggle camera follow |
| V | reveal everything, then click a creature to follow it |

The HUD along the bottom shows a food bar, an inventory hotbar (sprite icons, stack counts like "stick ×2", and progress bars on anything being sharpened or cooked; hover a slot for details), and a card for a fire you are next to. Above it is a row of keycaps for E Q X R T C G that light up only when that action is possible right now; greyed ones say why on hover, and a fresh press that can't be done shows the reason. Clicking a creature in god view shows its inventory the same way. **Speed** cycles ×1 / ×10 / ×100 and **Replay** re-runs your session from the seed and your inputs and reports whether it matched.

## The world and the rules

- **Terrain** is a tile grid generated from the seed: plains and forest, with a tree occupying some forest tiles. **Creatures and items live at real-valued positions** (in tile units), and bodies collide with trees and slide along them.
- **Time** is a fixed tick (20 per second in the browser). Humans walk 0.5 tiles/tick, or 0.25 sneaking; a fleeing deer runs 0.9.
- **Food** falls by 1 every 2 ticks from 1000; you starve at 0. Cooked meat restores 500.
- **Crafting:** sharpening takes 200 ticks, lighting a fire 30, a lit fire burns 800, and cooking takes 60. Progress is stored on the item or fire in the world (never on the actor), so putting a stick down and picking it up again loses nothing.
- **Vision is limited.** A human sees a 140° cone in front of them out to 10 tiles, and trees block line of sight. Anything within 1.5 tiles is always noticed. Deer see 300°, so their only blind spot is straight behind them.
- **The deer have a life cycle, and a food supply.** Every non-tree tile holds grass (plains up to 20 units, forest up to 10) that regrows slowly and is eaten down by grazing. A deer has energy that drains steadily; below a threshold it walks to the nearest decent patch and grazes until full, and it starves at zero. Fawns take 1,500 ticks to become adults, and adults die of old age at a randomly rolled 20,000–30,000 ticks. A well-fed adult with another adult nearby can breed (with a cooldown and an energy cost), and the fawn starts small. There is no population cap and no respawn timer: **the herd is limited only by the grass**, so the herd finds its own size (on the default 96x96 map it booms on the untouched grass, then settles around 100-150 whichever seed you use) and can boom and bust. Humans hunting them is the only predation.
- **Hunting.** A deer hears normal footsteps from 6 tiles away in any direction (30% chance per tick to notice). A *sneaking* human is only noticed if a deer can actually see them, within 2 tiles (3% per tick). So: approach from behind, sneaking. To stab you must hold a spear, be within 1.2 tiles, and face the deer.

## How it is built

```
sim/       the simulation. No DOM or Canvas: runs headless in Node.
  sim.js       fixed-tick loop, entities, deer, sticks, brains
  actions.js   the rules: what each action does
  observe.js   what a brain is allowed to see
  vision.js    cones and line of sight
  worldgen.js  seeded terrain and trees
  brains.js    non-AI brains: live input mailbox, replay script
  memory.js    TileMemory: the map a character has actually seen
  replay.js    replay a recorded session
  rng.js hash.js constants.js
npcs/      AI brains: basic.js (the baseline) and lib.js (helpers)
render/    Canvas rendering: render.js, sprites.js (pixel art drawn in code), animator.js
main.js    browser client: input, camera, replay button
ui/        the HUD: controls.js (what is possible now), inventory.js (HUD as data), hud.js (HTML)
server.py  a minimal static file server
tools/     ecosystem.mjs: a headless population harness (see below)
tests/     determinism, NPC, vision, replay, memory, animation, HUD, ecosystem
```

### Determinism

Given a seed and the same brains, a run is bit-for-bit identical. This is enforced, not hoped for:

- All randomness comes from seeded streams (`sim/rng.js`): one for world generation, one for the sim, and one per NPC.
- `sim/` and `npcs/` may use only IEEE-exact arithmetic (`+ - * /`, `Math.sqrt`, `floor`, `abs`, ...). `Math.random`, `Math.hypot`, trig, `**` and friends can differ between JS engines in the last bits, and a test (`tests/exact-math.test.js`) fails if they appear.
- Rendering (camera, zoom, interpolation between ticks, animation) never touches the sim. The speed button just runs more fixed ticks per frame.

`hashState(sim)` hashes the exact bits of every position and counter, and the tests compare hashes across runs. Headless, a full game runs far faster than real time: 20,000 ticks with three NPCs takes about a second.

### Every actor is a brain

NPCs and people share one interface. A **brain** is a generator function: each `yield` submits one action for this tick and returns the next observation.

```js
// npcs/example.js
export function* wanderer(obs, rng) {
  for (;;) {
    const deer = obs.view.entities.find((e) => e.kind === "deer");
    if (deer) {
      obs = yield { type: "face", dx: deer.x - obs.self.x, dy: deer.y - obs.self.y };
    } else {
      const [dx, dy] = rng.unit();               // never Math.random()
      obs = yield { type: "move", dx, dy };
    }
  }
}
```

Add it to a game with `sim.addActor(wanderer, tileX, tileY)`. The sim calls it every tick, so long tasks are just loops, and the NPC decides for itself when to look at the world and when to bail out. A brain that throws or returns is treated as idle; it can never crash the sim.

Two caveats for brain authors: a loop that never `yield`s will hang the whole simulation (JS cannot interrupt a generator), and an NPC has to remember what it saw, because it only ever sees what is in front of it.

**Observation** (fresh plain data each tick; mutating it changes nothing):

```
{ tick,
  reach: { pickup, stab, fire, stabFacingCos },          // how close/aligned you must be
  self:  { id, x, y, facing: [fx, fy], food, foodMax,
           inventory: [{ id, kind, ...progress }] },
  view:  { radius, x0, y0,                                // window of tiles around you
           tiles: ["..,T?", ...],                         // '.' plains ',' forest 'T' tree
           grass: ["98-30", ...],                         // '0'..'9' grass now, '-' none; '?' = not visible right now
           entities: [{ id, kind, x, y, ... }] },         // deer also carry adult: true/false
  lastResult: { ok, reason?, action } }
```

**Actions** (one per tick; anything else fails harmlessly with `unknown_action`):

| Action | Effect |
|---|---|
| `wait` | do nothing |
| `move {dx, dy, sneak}` | step in any direction; the sim normalizes it and sets your speed. You turn to face the way you move |
| `face {dx, dy}` | turn without moving |
| `pickup {item}` / `drop {item}` | within `reach.pickup` |
| `sharpen {item}` | +1 progress on a held stick; at 200 it becomes a spear |
| `stab {target}` | kill a deer within `reach.stab` and in front of you; it becomes raw meat |
| `make_fire {items: [a, b]}` | consume two held sticks to place an unlit fire at your feet |
| `tend {item}` | +1 progress on a fire within `reach.fire` |
| `cook {item, fire}` | +1 progress on held raw meat next to a lit fire |
| `eat {item}` | eat cooked meat |

`npcs/basic.js` is a complete example, and `npcs/lib.js` has helpers (tile pathfinding that steers to real positions, `walkNear`, `explore`, ...).

### Players, replay and memory

A person is just another brain. `sim/brains.js` provides `inputBrain(mailbox)` (acts on whatever the keyboard last put in the mailbox, otherwise waits) and `scriptedBrain(log)` (replays recorded actions). Give an actor `{ record: true }` and every non-wait action it takes is written to `sim.inputLog`; the seed, the setup and that log are enough to reproduce the game exactly:

```js
const sim = replay(makeSim, log, ticks);   // makeSim(humanBrain) builds the same game each time
```

`sim.observe(id)` returns exactly what that actor's brain would receive, and the client draws the player's screen from it, so the player sees no more than their character can perceive. `TileMemory` (`sim/memory.js`) keeps the most recent state of every tile a character has seen; the player's map shows what is visible now plus what it remembers, and everything else stays blank.

### Watching the ecosystem

```bash
node tools/ecosystem.mjs [seeds=6] [ticks=100000] [npcs=0]
```

runs the world headless for a long time and prints the deer population over time, the herd's min and max, how much grass is left, and births, starvations, old-age deaths and kills per seed. Use it to check a change to the deer or grass constants (`sim/constants.js`) hasn't led to extinction or a runaway herd. Add NPCs to see how much hunting matters.

## Not built yet

Houses and building, combat between people, more animals, day/night, click-to-move, and saving/loading (replay from seed plus log works today). PRs and ideas welcome.
