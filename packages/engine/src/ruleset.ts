import type { RuleModule } from "./types.js";
import { body } from "./modules/body.js";
import { combat } from "./modules/combat.js";
import { corpses } from "./modules/corpses.js";
import { feeding } from "./modules/feeding.js";
import { metabolism } from "./modules/metabolism.js";
import { movement } from "./modules/movement.js";
import { plants } from "./modules/plants.js";
import { reproduction } from "./modules/reproduction.js";
import { senses } from "./modules/senses.js";
import { flora } from "./modules/flora.js";

export const STANDARD_RULESET_VERSION = "standard@2";

export function standardModules(): RuleModule[] {
  return [body, senses, movement, metabolism, plants, flora, corpses, feeding, combat, reproduction];
}
