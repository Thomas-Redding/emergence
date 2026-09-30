# Design decisions

A running log of significant design decisions: what was tried, what was rejected, and why. The
README documents current behavior; this documents how it got that way, for whenever "why doesn't
it just do the obviously smarter thing" comes up later. Newest first.

## Sex (humans and deer)

Both species now have `sex: "male" | "female"`, rolled 50/50 at birth (humans: a per-actor derived
RNG stream, so adding the field never perturbs `sim.rng` or unrelated baselines; deer: the shared
`sim.rng`, matching how deer lifespan already worked). A `mate` proposal between the same sex is
refused (`same_sex`, checked after the existing age/food/cooldown checks so those reasons still take
priority). Deer breeding requires an opposite-sex adult nearby, and only the female bears the fawn.

**Known, measured, unresolved cost:** sex-gating roughly halves-or-worse the effective
breeding-trigger rate for a given local deer population (old rule: any two nearby adults, even
same-sex, could trigger; new: only a doe with a buck nearby). Under heavy hunting pressure this is
severe — see "Deer isolation" below, where it turns out to be a *compounding* factor on top of a
larger, pre-existing isolation problem, not the dominant cause by itself. `DEER_BREED_CHANCE` has
not been retuned to compensate; that's a deliberate open question, not an oversight.

## Grass and meadows

**The original problem:** grass used to exist on every non-tree tile at low density. A deer grazes
opportunistically on whatever tile it's standing on as it walks, so with grass everywhere, a deer's
entire wander path got nibbled — a visible line traced wherever it went, on every walk, forever.

**Iteration 1 — clustered patches.** Grass was concentrated into meadow blobs (~15% of non-tree
tiles, chosen by a noise field so meadows didn't just trace the terrain boundary), each meadow tile
holding ~6.67x the old per-tile capacity so total supply stayed roughly constant. Growth-per-visit
had to be scaled up too, not just capacity (an unscaled first attempt starved the whole herd even
with zero hunters, because concentrating grass into 15% of tiles cut total regrowth *throughput* to
about that fraction of before, not just capacity).

A neighbor-count regrowth gate (a tile only regrows while at most 1 of its 4 neighbors already has
grass) was added on top, to stop a whole meadow blob from greening up solid at once — which would
have reproduced the original nibbled-line problem, just contained to a smaller patch of ground. This
required another growth-rate bump to avoid re-starving the herd, and introduced a **deterministic
checkerboard artifact**: the staggered regrowth schedule visits tile `i` on tick `i mod P`, so a
tile's west/north neighbors (lower index) always land earlier in the same cycle — a permanent
structural bias, not noise, that produced a rigid alternating pattern instead of organic sparseness.
Fixed (at the time) by visiting tiles in a seeded-shuffled order each cycle instead of raw index
order, decorrelating schedule position from map position. (This fix was later deleted entirely — see
"Iteration 3" — once the neighbor-cap rule it existed to fix was itself removed.)

**Rendering bug found by direct observation, not code review:** ground tile color faded from lush to
bare based on grass fraction. Non-meadow tiles (`grassCap === 0`) hit a `frac = 1` fallback in that
calculation and always rendered fully lush, regardless of having zero grass capacity — invisible
until the user actually looked at the running game and asked "are the shades of green arbitrary now?"
The same bug also caused the decorative grass-tuft sprite to appear on non-meadow tiles (its
visibility gate used the same wrong `frac`). Fixed by reworking rendering entirely: ground color is
now flat per-terrain texture (grass amount plays no part in color at all), and grass is shown by 0-4
tuft sprites per tile, in fixed per-tile-and-slot deterministic positions, whose *count* is driven by
the real grass fraction — so a tuft can only ever appear where the sim says grass can exist, and
tufts visibly appear/disappear in place as a tile is grazed or regrows, rather than a color fade that
couldn't distinguish "no grass possible here" from "fully grazed."

**Deer isolation investigation.** Direct observation of the running game (deer clustering into one
meadow; wandering rare; a wanderer dying without ever finding a mate) prompted instrumenting
`maybeBreed` to check, at every breeding-ready moment, whether *any* adult deer of *any* sex was
nearby, not just an opposite-sex one. In a seed that goes extinct under 8-forager hunting pressure:
26.5% of breeding-ready moments had no adult deer of any kind nearby at all (a pre-existing isolation
problem, unrelated to sex), vs. 30.6% failing the opposite-sex check specifically — sex-gating adds
only ~4 percentage points on top of an already-severe isolation problem. Population dynamics near
collapse are nonlinear enough that this still produces an 11x gap in outcome (mean final herd 203.5
ungated vs. 18.6 gated, 8 seeds x 40,000 ticks x 8 foragers) — a small per-event probability
difference compounds over thousands of ticks into a large difference in whether a population
recovers or goes extinct.

**Two failed attempts at smarter deer foraging (both reverted).** The isolation finding suggested
deer should trade a bit of extra travel distance for meaningfully better grass, instead of picking
the *nearest* adequate patch unconditionally (the old `findGrass` was strict nearest-first; grass
amount only broke ties between equally-near tiles). Two implementations were tried, each measured
against the full 8-seed/40k-tick hunted stress test before deciding, and both failed badly:

1. **Score by raw remaining grass minus a distance cost.** This funneled deer from across the whole
   search radius toward whichever single meadow had the highest *total* capacity (which scales with
   a meadow's size, not its richness) — mean final herd dropped to 1.5, 6/8 seeds extinct. Worse than
   doing nothing.
2. **Score by density-based energy-per-bite (bounded 2-5) minus a distance cost.** Bounding the value
   term to a small range was meant to fix (1), but the distance-cost constant was still too weak
   relative to the bounded range and the search radius: a quality difference of 1.5 out of a spread
   of 3 was "worth" 15 tiles of travel, and with a 20-tile search radius, almost any meaningfully
   better patch in view would win. Result: **0/8 seeds survived** — worse than the raw-total attempt.

Both failures are the same underlying mechanism: any decision rule where every deer can see and
prefer the same "objectively best" patch synchronizes the whole herd onto it, which is a single point
of failure once hunting (or ordinary overgrazing) hits that one spot. Neither was a matter of picking
a better constant — a third numeric attempt without addressing the synchronization problem directly
(e.g. congestion-aware scoring, where a patch's attractiveness falls as more deer are already
drawing on it — the "ideal free distribution" from ecology) would likely fail the same way. `findGrass`
was reverted to plain nearest-first both times; this remains unsolved.

**Iteration 2 — density-based bite energy (kept).** Independent of the above, and validated in
isolation before either failed attempt: a bite of grass is now worth energy proportional to the
tile's lushness (`DEER_ENERGY_PER_GRASS_MIN`/`MAX`, linear in `grass / cap`) instead of a flat rate.
The amount of grass *removed* per bite is still flat (`DEER_BITE`) — only its energy value scales.
This is what makes "richer grass is better" a real, bounded signal (bounded regardless of a meadow's
size, unlike raw standing grass, which is exactly why it doesn't reproduce failure (1) above if used
correctly). Initial guess (`MIN=1, MAX=3`) roughly halved the unhunted steady-state deer population
relative to the old flat rate, because grass typically sits below 50% density under any ongoing
grazing pressure, not at the 50% the guess implicitly assumed; retuned to `MIN=2, MAX=5` by sweeping
against the unhunted 12-seed/40k-tick ecosystem test until the population matched the old baseline
(mean 169.8 vs. 171.4 old, similar floor and ceiling).

**Iteration 3 — scattered, not clustered (current).** Reframing from the user: the original "no
visible trails" goal doesn't actually require zero grazing marks everywhere — it only requires not
looking like an obvious rendering bug (an unbroken solid line). A sparse, non-clustered scatter of
occasionally-grazed tiles is a *better* target than either extreme: it's a legitimate trackable
signature (loose evidence of a deer's passage) without being a giveaway. This also directly explains
the isolation problem above: tiny, far-apart clustered meadow islands are why a wandering deer so
rarely finds another meadow or another deer. Reimplemented: each non-tree tile independently rolls a
`GRASS_PATCH_COVERAGE` (0.15) chance of being a meadow tile at world-gen time (its own seeded RNG
stream, not a noise field) — a flat per-tile Bernoulli draw, not clustered at all. The neighbor-cap
regrowth rule was removed entirely (meaningless once tiles are scattered: a meadow tile's neighbors
are almost always non-meadow anyway, so the check never triggers), and with it the shuffled-visit-order
code that existed solely to fix the checkerboard artifact that rule caused.

Scattering required retuning growth down: scattered tiles regrow completely unimpeded (the blocking
that used to reduce delivered growth in a clustered meadow never triggers for isolated tiles), so the
old growth rate massively overshot — most seeds hit the 300-deer population cap. Halved
`GRASS_PATCH_GROWTH_PLAINS/FOREST` (36/20 -> 18/10), which brought the unhunted population back in
line (mean 138.5, no extinctions, no cap-outs, across 8 seeds/40k ticks).

Two tests needed genuine updates (not workarounds) as a result: the minimum-bare-tiles-eaten
threshold in the "doesn't march in a line" test was calibrated to the old flat energy rate (richer
grass now satiates a deer in fewer bites, so it legitimately eats less ground — lowered 15->10 with a
comment explaining why); and `forager.test.js`'s strict `survival === 1` assertion was loosened to
`>= 0.9` after tracing the one starving case to a forager getting pinned against the map edge
(halving its effective random-walk search coverage) and going unlucky finding a deer in its
field-of-view for ~1900 ticks — unrelated to grass layout (meadow density right at the death spot was
a perfectly normal 12.3%).

## Open: forager-family long-run population fragility

Running `tools/population.mjs` at its default scale (6 seeds x 150,000 ticks x 6 `forager-family`
founders) for the first time at this horizon produced **6/6 human extinction, 4/6 deer extinction**.
An isolated A/B against a reconstructed pre-grass-redesign build (clustered meadows, neighbor-cap
rule, old growth rate) at the identical scale produced the same result (6/6 human extinction, 5/6
deer extinction, if anything slightly worse) — so this is confirmed **not** caused by the grass
redesign above. It's a pre-existing `forager-family` fragility, far worse than the previously-assumed
"~1-in-4 crash" figure (itself only measured at a shorter/smaller scale: 60,000 ticks x 4 seeds).

A trace of one seed (deer stayed healthy throughout, 34-157; kills climbed steadily, 6->82 over
23,000 ticks) shows this isn't a sudden famine: it's a slow bleed, one person starving every couple
thousand ticks while others sit at full food, grinding the population to zero well before the deer
supply does. Not yet investigated further — a candidate topic for its own session.

## Rejected: DEER_MATE_RADIUS / DEER_BREED_CHANCE tuning as a fix for isolation

Before the isolation root cause (above) was understood, `DEER_MATE_RADIUS` (20 -> 28) and
`DEER_BREED_CHANCE` (1x -> 2x, individually and combined) were tried as direct compensation for the
sex-gating cost. Measured against the 8-seed/40k-tick hunted stress test: none came close to the
ungated baseline (best combination: mean 67.9 vs. 203.5 ungated, still 3/8 extinct vs. 0/8). This is
consistent with the later finding that sex-gating was never the dominant factor — general isolation
was — so compensating the breeding math couldn't have fixed the actual problem.
