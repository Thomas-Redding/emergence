// Render-side animation state. Pure logic (no DOM), so it can be unit-tested. Nothing here touches
// the sim: it only watches where things are drawn, frame to frame, and which action a character
// last performed.

export const STRIDE = 0.6; // walk cycles per tile travelled (so the gait matches speed at any sim speed)
const MOVING_GRACE_MS = 150; // still "walking" this long after the last movement (smooths tick gaps)
const ACTION_HOLD_MS = 220; // an action keeps animating this long after the sim last reported it

// Actions worth animating, and whether they are one-shot (a single gesture) or looping.
export const ANIMATED = { stab: "once", pickup: "once", eat: "once", sharpen: "loop", tend: "loop", cook: "loop", make_fire: "once" };
export const ONCE_MS = 240;

// Which sprite row and mirroring for a facing vector. Sprites face right; left is the mirror.
export function spriteDir(fx, fy) {
  if (Math.abs(fx) > Math.abs(fy)) return { dir: "side", flip: fx < 0 };
  return { dir: fy > 0 ? "down" : "up", flip: false };
}

export class Animator {
  constructor() {
    this.states = new Map();
  }

  // Call once per creature per frame with its *drawn* position. facing is the true facing vector if
  // the viewer knows it, else null (then it is inferred from the way the creature moves).
  track(id, x, y, facing, time) {
    let st = this.states.get(id);
    if (!st) {
      st = { x, y, phase: 0, fx: 0, fy: 1, lastMove: -1e9, action: null, actionStart: 0, actionUntil: 0 };
      this.states.set(id, st);
    }
    const dx = x - st.x, dy = y - st.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-4 && d < 2) { // (d >= 2 would be a teleport, not a walk)
      st.phase += d * STRIDE;
      st.lastMove = time;
      if (!facing) { st.fx = dx / d; st.fy = dy / d; }
    }
    if (facing) { st.fx = facing[0]; st.fy = facing[1]; }
    st.x = x;
    st.y = y;
    st.lastSeen = time;
    st.moving = time - st.lastMove < MOVING_GRACE_MS;
    st.frame = st.moving ? Math.floor(st.phase * 4) % 4 : 0; // 4-frame walk cycle; 0 = standing
    Object.assign(st, spriteDir(st.fx, st.fy));
    return st;
  }

  // Tell the animator what the character's last action result was (null if unknown/not visible).
  setAction(st, result, time) {
    const a = result && result.ok ? result.action : null;
    if (!(a in ANIMATED)) return;
    if (st.action !== a || time > st.actionUntil) st.actionStart = time; // a new gesture begins
    st.action = a;
    st.actionUntil = time + ACTION_HOLD_MS;
  }

  // The gesture in progress, or null. t is seconds since it began; p is 0..1 for one-shot gestures.
  activeAction(st, time) {
    if (!st.action || time > st.actionUntil) return null;
    const ms = time - st.actionStart;
    if (ANIMATED[st.action] === "once" && ms > ONCE_MS) return null;
    return { type: st.action, t: ms / 1000, p: Math.min(1, ms / ONCE_MS) };
  }

  // Forget creatures not drawn for a while (dead, or out of sight for good).
  prune(time, maxAgeMs = 5000) {
    for (const [id, st] of this.states) if (time - st.lastSeen > maxAgeMs) this.states.delete(id);
  }
}
