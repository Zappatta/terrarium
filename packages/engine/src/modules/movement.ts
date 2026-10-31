import type { Vec2 } from "@terrarium/sdk";
import type { RuleModule } from "../types.js";
import { moduleParams } from "../params.js";
import { dist, isFiniteVec } from "../vec.js";

export interface MotionComponent {
  target: Vec2 | null;
  speed: number;
  maxSpeed: number;
  /** Distance covered last tick, for metabolism. */
  moved: number;
}

declare module "../types.js" {
  interface Components {
    motion: MotionComponent;
  }
}

export const MOVEMENT = "movement";
export const movementParams = moduleParams(MOVEMENT, { speedBase: 1, speedPerPoint: 0.4 });

export const movement: RuleModule = {
  id: MOVEMENT,
  traits: [{ name: "speed", min: 0, max: 10, default: 3 }],
  actions: [
    {
      type: "move",
      handle(world, actor, action) {
        if (action.type !== "move") return;
        const m = actor.c.motion;
        if (!m) return "plants cannot move";
        if (!isFiniteVec(action.to)) return "invalid target";
        const speed = action.speed === undefined ? m.maxSpeed : Number(action.speed);
        if (!Number.isFinite(speed) || speed <= 0) return "invalid speed";
        m.target = world.clampToWorld({ x: action.to.x, y: action.to.y });
        m.speed = Math.min(speed, m.maxSpeed);
      },
    },
    {
      type: "stop",
      handle(_world, actor) {
        if (actor.c.motion) actor.c.motion.target = null;
      },
    },
    { type: "idle", handle() {} },
  ],
  systems: [
    {
      phase: "physics",
      run(world) {
        for (const e of world.all("animal")) {
          const m = e.c.motion;
          if (!m) continue;
          m.moved = 0;
          if (!m.target) continue;
          const d = dist(e.pos, m.target);
          if (d <= m.speed) {
            m.moved = d;
            world.move(e, m.target);
            m.target = null;
            world.emit(e.id, { type: "arrived" });
          } else {
            const k = m.speed / d;
            m.moved = m.speed;
            world.move(e, { x: e.pos.x + (m.target.x - e.pos.x) * k, y: e.pos.y + (m.target.y - e.pos.y) * k });
          }
        }
      },
    },
  ],
  onOrganismCreated(world, e) {
    if (e.kind !== "animal") return;
    const p = movementParams(world);
    const maxSpeed = p.speedBase + p.speedPerPoint * e.c.species!.traits.speed!;
    e.c.motion = { target: null, speed: maxSpeed, maxSpeed, moved: 0 };
  },
  extendSelf(_world, e, self) {
    if (e.kind !== "animal") return;
    const m = e.c.motion;
    self.moving = !!m?.target;
    self.target = m?.target ? { ...m.target } : null;
    self.maxSpeed = m?.maxSpeed ?? 0;
  },
};
