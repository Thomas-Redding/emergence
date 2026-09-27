import test from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../sim/sim.js";
import { hashState } from "../sim/hash.js";
import { replay } from "../sim/replay.js";
import { makeInput, inputBrain } from "../sim/brains.js";
import * as C from "../sim/constants.js";

// Scripted people: `script[tick]` is the action they take at that tick (otherwise they wait). Every
// observation they receive is recorded in `log[tick]`. Scripts can be functions of the ids, which are only
// known once everyone has been added.
function scene(people, { kinds = {} } = {}) {
  const s = new Sim({ seed: 1 });
  s.world.treeAt.fill(0);
  s.entities = [];
  s.byIdMap.clear();
  for (const [name, fn] of Object.entries(kinds)) s.proposalKinds.set(name, fn);
  const ids = {}, logs = {}, actors = {};
  for (const [name, { at, script = {}, age }] of Object.entries(people)) {
    logs[name] = [];
    const brain = function* (obs) {
      for (;;) {
        logs[name].push(obs);
        const act = typeof script === "function" ? script(ids)[obs.tick] : script[obs.tick];
        obs = yield act ?? { type: "wait" };
      }
    };
    actors[name] = s.addActor(brain, at[0], at[1], age === undefined ? {} : { age });
    ids[name] = actors[name].id;
  }
  return { s, ids, logs, actors };
}
const wave = { accept: () => ({ ok: true }) };
const A = [40, 40], B_NEAR = [40, 42]; // A faces south, so B two tiles south is in front of A, in range, and visible
const propose = (to, kind = "wave") => ({ type: "wait", propose: { to, kind } });
const respond = (to, accept) => ({ type: "wait", respond: { to, accept } });
const ofType = (obs, type) => obs.events.filter((e) => e.type === type);

test("a proposal reaches its recipient on the NEXT tick, and only its recipient", () => {
  const { s, ids, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b) }) },
    b: { at: B_NEAR },
    c: { at: [41, 41] }, // right there, watching
  }, { kinds: { wave } });
  s.run(4);
  assert.equal(logs.b[0].events.length, 0, "not delivered in the tick it was sent");
  const got = ofType(logs.b[1], "proposal");
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { type: "proposal", id: 1, kind: "wave", from: ids.a, expires: C.PROPOSAL_TICKS });
  assert.deepEqual(ofType(logs.a[1], "proposal_sent")[0], { type: "proposal_sent", id: 1, kind: "wave", to: ids.b, expires: C.PROPOSAL_TICKS });
  assert.equal(logs.c[1].events.length, 0, "private: a bystander hears nothing");
  assert.deepEqual([logs.c[1].proposals.incoming, logs.c[1].proposals.outgoing], [[], null]);
});

test("events arrive once; the standing proposal state stays visible until it is resolved", () => {
  const { s, ids, logs } = scene({ a: { at: A, script: (id) => ({ 0: propose(id.b) }) }, b: { at: B_NEAR } }, { kinds: { wave } });
  s.run(6);
  assert.equal(ofType(logs.b[1], "proposal").length, 1);
  assert.equal(logs.b[2].events.length, 0, "delivered once");
  for (const t of [1, 2, 3, 5]) {
    assert.deepEqual(logs.b[t].proposals.incoming, [{ id: 1, kind: "wave", from: ids.a, expires: 100 }], `tick ${t}: still pending`);
    assert.deepEqual(logs.a[t].proposals.outgoing, { id: 1, kind: "wave", to: ids.b, expires: 100 });
  }
  assert.deepEqual(logs.b[0].proposals.incoming, [], "and nothing before it was sent");
});

test("speech doesn't cost the tick's action: a move can carry a proposal", () => {
  const { s, ids, logs, actors } = scene({
    a: { at: A, script: (id) => ({ 0: { type: "move", dx: 0, dy: 1, propose: { to: id.b, kind: "wave" } } }) },
    b: { at: B_NEAR },
  }, { kinds: { wave } });
  const y0 = actors.a.y;
  s.run(2);
  assert.ok(actors.a.y > y0, "it moved (toward B, so B is still in front of it when the speech is resolved)");
  assert.equal(logs.a[1].lastResult.action, "move", "lastResult is about the main action");
  assert.equal(logs.a[1].lastResult.ok, true);
  assert.equal(s.proposals.length, 1, "and the proposal exists");
});

test("accepting runs the kind's handler and tells both people", () => {
  let called = null;
  const { s, ids, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b) }) },
    b: { at: B_NEAR, script: (id) => ({ 1: respond(id.a, true) }) },
  }, { kinds: { wave: { accept: (sim, from, to) => { called = [from.id, to.id]; return { ok: true }; } } } });
  s.run(4);
  assert.deepEqual(called, [ids.a, ids.b], "handler(asker, answerer)");
  assert.deepEqual(ofType(logs.a[2], "proposal_result"), [{ type: "proposal_result", id: 1, kind: "wave", with: ids.b, outcome: "accepted" }]);
  assert.deepEqual(ofType(logs.b[2], "proposal_result"), [{ type: "proposal_result", id: 1, kind: "wave", with: ids.a, outcome: "accepted" }]);
  assert.equal(s.proposals.length, 0);
  assert.deepEqual(logs.b[3].proposals.incoming, []);
});

test("declining ends it, and the asker can't ask the same person again for a while", () => {
  const { s, ids, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b), 2: propose(id.b), [1 + C.DECLINE_COOLDOWN]: propose(id.b) }) },
    b: { at: B_NEAR, script: (id) => ({ 1: respond(id.a, false) }) },
  }, { kinds: { wave } });
  s.run(4);
  assert.equal(ofType(logs.a[2], "proposal_result")[0].outcome, "declined");
  assert.equal(ofType(logs.b[2], "proposal_result")[0].outcome, "declined");
  assert.equal(ofType(logs.a[3], "speech_failed")[0].reason, "cooldown", "the second ask (tick 2) is refused");
  assert.equal(s.proposals.length, 0);
  s.run(C.DECLINE_COOLDOWN - 4 + 1); // up to the tick before the cooldown ends
  assert.equal(s.proposals.length, 0, "still nothing during the cooldown");
  s.run(1); // the tick the third ask is made: the cooldown has just passed
  assert.equal(s.proposals.length, 1, "allowed again once it has passed");
  s.run(1);
  assert.equal(ofType(logs.b[C.DECLINE_COOLDOWN + 2], "proposal").length, 1, "and delivered on the next tick");
});

test("accepting a kind whose conditions fail is reported as invalid, with the reason", () => {
  const { s, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b, "mate") }) },
    b: { at: B_NEAR, script: (id) => ({ 1: respond(id.a, true) }) },
  });
  s.run(3);
  const r = ofType(logs.a[2], "proposal_result")[0];
  assert.deepEqual([r.outcome, r.reason], ["invalid", "not_implemented"], "'mate' exists but does nothing yet");
  assert.equal(s.proposals.length, 0);
});

// Try one proposal in a prepared scene and return the reason it was refused (null if it went through).
function refusal({ propose: p, b = { at: B_NEAR }, prepare = () => {}, extra = {} }) {
  const { s, ids, logs, actors } = scene({ a: { at: A, script: (id) => ({ 0: typeof p === "function" ? p(id) : p }) }, b, ...extra }, { kinds: { wave } });
  prepare(s, ids, actors);
  s.run(2);
  const failed = ofType(logs.a[1], "speech_failed");
  return failed.length ? failed[0].reason : null;
}

test("each way a proposal can be refused says why", () => {
  assert.equal(refusal({ propose: (id) => propose(id.b) }), null, "control: this one works");
  assert.equal(refusal({ propose: (id) => propose(id.b), b: { at: [40, 47] } }), "out_of_range", "5 tiles is too far");
  assert.equal(refusal({ propose: (id) => propose(id.b), b: { at: [40, 37] } }), "not_visible", "3 tiles away but behind you");
  assert.equal(refusal({ propose: (id) => propose(id.a) }), "no_such_person", "yourself");
  assert.equal(refusal({ propose: propose(9999) }), "no_such_person");
  assert.equal(refusal({ propose: (id) => propose(id.b, "nonsense") }), "unknown_kind");
  assert.equal(refusal({ propose: { type: "wait", propose: null } }), "bad_speech");
  assert.equal(refusal({ propose: { type: "wait", propose: { to: "b", kind: "wave" } } }), "bad_speech");
  assert.equal(refusal({ propose: (id) => ({ type: "wait", propose: { to: id.b, kind: "wave" }, respond: { to: id.b, accept: true } }) }), "one_message_per_tick");
  assert.equal(refusal({ propose: (id) => propose(id.b), prepare: (s, ids) => s.killPerson(s.byId(ids.b), "starvation") }), "no_such_person", "the dead can't be asked");
  assert.equal(refusal({ propose: (id) => propose(id.deer), prepare: (s, ids) => { ids.deer = s.spawnDeer(40.5, 42.5, { age: 5000, energy: 1000 }).id; } }), "no_such_person", "a deer is not a person");
});

test("only one proposal out at a time", () => {
  const { s, ids, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b), 1: propose(id.c) }) },
    b: { at: B_NEAR }, c: { at: [41, 42] },
  }, { kinds: { wave } });
  s.run(3);
  assert.equal(ofType(logs.a[2], "speech_failed")[0].reason, "already_pending");
  assert.equal(s.proposals.length, 1);
});

test("crossing proposals both stand, and each person has one out and one in", () => {
  const { s, ids, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b) }) },
    // B faces south, away from A, so B first turns north; turning and asking in one action is fine
    b: { at: B_NEAR, script: (id) => ({ 0: { type: "face", dx: 0, dy: -1, propose: { to: id.a, kind: "wave" } } }) },
  }, { kinds: { wave } });
  s.run(2);
  assert.equal(s.proposals.length, 2);
  for (const [me, other] of [["a", "b"], ["b", "a"]]) {
    assert.equal(logs[me][1].proposals.outgoing.to, ids[other]);
    assert.deepEqual(logs[me][1].proposals.incoming.map((p) => p.from), [ids[other]]);
  }
});

test("who acts first doesn't matter: the recipient hears about it on the next tick either way", () => {
  for (const proposer of ["a", "b"]) { // a has the lower id, so acts first; b acts second
    const other = proposer === "a" ? "b" : "a";
    const { s, logs } = scene({
      a: { at: A, script: proposer === "a" ? (id) => ({ 0: propose(id.b) }) : {} },
      b: { at: B_NEAR, script: proposer === "b" ? (id) => ({ 0: { type: "face", dx: 0, dy: -1, propose: { to: id.a, kind: "wave" } } }) : {} },
    }, { kinds: { wave } });
    s.run(3);
    assert.equal(ofType(logs[other][0], "proposal").length, 0, `${proposer} proposes: not heard in the same tick`);
    assert.equal(ofType(logs[other][1], "proposal").length, 1, `${proposer} proposes: heard on the next`);
  }
});

test("a proposal can't be answered in the tick it is made", () => {
  const { s, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b) }) },
    b: { at: B_NEAR, script: (id) => ({ 0: respond(id.a, true) }) }, // B answers before having heard anything
  }, { kinds: { wave } });
  s.run(2);
  assert.equal(ofType(logs.b[1], "speech_failed")[0].reason, "no_such_proposal");
  assert.equal(s.proposals.length, 1, "and the proposal is still waiting");
});

test("only the person asked can answer", () => {
  const { s, logs } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b) }) },
    b: { at: B_NEAR }, c: { at: [41, 42], script: (id) => ({ 1: respond(id.a, true) }) },
  }, { kinds: { wave } });
  s.run(3);
  assert.equal(ofType(logs.c[2], "speech_failed")[0].reason, "no_such_proposal");
  assert.equal(s.proposals.length, 1, "still pending");
});

test("answering from too far away is refused but leaves it pending; on returning it can be answered", () => {
  const walk = (dy, from, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [from + i, { type: "move", dx: 0, dy }]));
  const { s, ids, logs, actors } = scene({
    a: { at: A, script: (id) => ({ 0: propose(id.b) }) },
    b: { at: B_NEAR, script: (id) => ({ ...walk(1, 1, 6), 7: respond(id.a, true), ...walk(-1, 8, 7), 15: respond(id.a, true) }) },
  }, { kinds: { wave } });
  s.run(9); // ticks 0-8
  assert.ok(Math.abs(actors.b.y - actors.a.y) > C.TALK_RANGE, "B really is out of range at that point");
  assert.equal(ofType(logs.b[8], "speech_failed")[0].reason, "out_of_range", "B answered from 5 tiles away");
  assert.equal(s.proposals.length, 1, "the proposal survives it");
  s.run(9);
  assert.equal(ofType(logs.a[16], "proposal_result")[0].outcome, "accepted", "answered from 1.5 tiles after walking back");
});

test("unanswered proposals expire for both people", () => {
  const { s, ids, logs } = scene({ a: { at: A, script: (id) => ({ 0: propose(id.b), [C.PROPOSAL_TICKS]: propose(id.b) }) }, b: { at: B_NEAR } }, { kinds: { wave } });
  s.run(C.PROPOSAL_TICKS - 1);
  assert.equal(s.proposals.length, 1, "still pending just before it expires");
  s.run(1);
  s.run(2);
  const t = C.PROPOSAL_TICKS;
  assert.equal(ofType(logs.a[t], "proposal_result")[0].outcome, "expired");
  assert.equal(ofType(logs.b[t], "proposal_result")[0].outcome, "expired");
  assert.deepEqual(logs.b[t].proposals.incoming, [], "gone from the state too");
  assert.equal(s.proposals.length, 1, "and it can be asked again straight away (a new one, made this tick)");
});

test("if either person dies, the proposal goes and the survivor is told", () => {
  for (const dies of ["a", "b"]) {
    const { s, ids, logs, actors } = scene({ a: { at: A, script: (id) => ({ 0: propose(id.b) }) }, b: { at: B_NEAR } }, { kinds: { wave } });
    s.run(2);
    s.killPerson(actors[dies], "old_age");
    s.run(1);
    const survivor = dies === "a" ? "b" : "a";
    const last = logs[survivor][logs[survivor].length - 1];
    assert.deepEqual(ofType(last, "proposal_result").map((e) => [e.outcome]), [["gone"]], `${survivor} hears that it's gone`);
    assert.equal(s.proposals.length, 0);
  }
});

test("observations hold copies of events, and the inbox is capped", () => {
  const { s, ids, actors } = scene({ a: { at: A }, b: { at: B_NEAR } });
  s.emit(actors.a, { type: "hello", id: 1 });
  const o = s.observe(ids.a);
  o.events[0].type = "hacked";
  assert.equal(s.observe(ids.a).events[0].type, "hello", "the sim's copy is untouched");
  for (let i = 0; i < 100; i++) s.emit(actors.a, { type: "n", id: i });
  assert.equal(actors.a.inbox.length, C.INBOX_MAX);
  assert.equal(actors.a.inbox[0].id, 100 - C.INBOX_MAX, "oldest dropped first");
});

test("speech is world state: it changes the hash, and repeats identically", () => {
  const build = (declineCooldown = false) => {
    const { s, ids } = scene({ a: { at: A, script: (id) => ({ 0: propose(id.b) }) }, b: { at: B_NEAR, script: (id) => (declineCooldown ? { 1: respond(id.a, false) } : {}) } }, { kinds: { wave } });
    s.run(3);
    return s;
  };
  assert.equal(hashState(build()), hashState(build()));
  assert.notEqual(hashState(build(false)), hashState(build(true)), "a pending proposal vs a decline cooldown differ");
  const bare = scene({ a: { at: A }, b: { at: B_NEAR } }).s;
  bare.run(3);
  assert.notEqual(hashState(bare), hashState(build(false)));
});

test("recorded speech replays exactly, including on a 'wait'", () => {
  const makeSim = (humanBrain) => {
    const s = new Sim({ seed: 3 });
    s.world.treeAt.fill(0);
    s.entities = [];
    s.byIdMap.clear();
    s.proposalKinds.set("wave", wave);
    const human = s.addActor(humanBrain, 40, 40, { record: true });
    const other = s.addActor(function* (obs) {
      for (;;) {
        const inc = obs.proposals.incoming[0];
        obs = yield inc ? { type: "wait", respond: { to: inc.from, accept: true } } : { type: "wait" };
      }
    }, 40, 42);
    return { s, human, other };
  };
  const input = makeInput();
  const { s: live, human, other } = makeSim(inputBrain(input));
  for (let t = 0; t < 12; t++) {
    if (t === 3) input.push({ type: "wait", propose: { to: other.id, kind: "wave" } });
    live.step();
  }
  const speech = live.inputLog.filter((e) => e.action.propose);
  assert.equal(speech.length, 1, "a wait carrying speech is logged (plain waits are not)");
  assert.deepEqual(speech[0], { tick: 3, actor: human.id, action: { type: "wait", propose: { to: other.id, kind: "wave" } } });
  const rep = replay((brain) => makeSim(brain).s, JSON.parse(JSON.stringify(live.inputLog)), 12);
  assert.equal(hashState(rep), hashState(live));
  assert.equal(live.proposals.length, 0, "the other person accepted it");
});

test("the rules a brain needs are in its observation", () => {
  const { s, ids } = scene({ a: { at: A } });
  const o = s.observe(ids.a);
  assert.equal(o.reach.talk, C.TALK_RANGE);
  assert.equal(o.rules.proposalTicks, C.PROPOSAL_TICKS);
  assert.deepEqual(o.events, []);
  assert.deepEqual(o.proposals, { incoming: [], outgoing: null });
});
