import { MODULE_ID } from "./module.mjs";

const ICONS = {
  generic: "icons/svg/book.svg",
  melee: "icons/svg/sword.svg",
  ranged: "icons/svg/bow.svg",
  magic: "icons/svg/daze.svg",
  breath: "icons/svg/dragon.svg",
  multi: "icons/svg/target.svg",
  fire: "icons/svg/fire.svg",
  cold: "icons/svg/snowflake.svg",
  poison: "icons/svg/poison.svg",
  lightning: "icons/svg/lightning.svg",
  necrotic: "icons/svg/skull.svg",
  radiant: "icons/svg/sun.svg",
  psychic: "icons/svg/brain.svg",
  force: "icons/svg/explosion.svg",
  thunder: "icons/svg/sound.svg",
  healing: "icons/svg/regen.svg",
  charm: "icons/svg/heart.svg",
  fear: "icons/svg/terror.svg",
  grapple: "icons/svg/net.svg",
  legendary: "icons/svg/crown.svg",
  summon: "icons/svg/wing.svg",
  teleport: "icons/svg/door-exit.svg"
};

const RULES = [
  { re: /legendary|légendaire/i, icon: ICONS.legendary },
  { re: /multiattack|attaque(s)? multiples?/i, icon: ICONS.multi },
  { re: /breath|souffle/i, icon: ICONS.breath },

  { re: /teleport|téléport|dimension door|porte dimension|misty step|pas brumeux|blink/i, icon: ICONS.teleport },
  { re: /summon|invoc|conjur|appel/i, icon: ICONS.summon },
  { re: /heal|healing|soin|regagne des points de vie|récupère des points de vie/i, icon: ICONS.healing },

  { re: /charm|charmé|ensorcel|séduc/i, icon: ICONS.charm },
  { re: /fear|frighten|apeur|effroi|terreur/i, icon: ICONS.fear },
  { re: /grapple|agripp|saisie|entrav/i, icon: ICONS.grapple },

  { re: /fire|feu|brûl|flame/i, icon: ICONS.fire },
  { re: /cold|froid|glace|ice/i, icon: ICONS.cold },
  { re: /poison|poisonn/i, icon: ICONS.poison },
  { re: /lightning|foudre|électr/i, icon: ICONS.lightning },
  { re: /necrotic|nécrot/i, icon: ICONS.necrotic },
  { re: /radiant|radieux|divin|holy/i, icon: ICONS.radiant },
  { re: /psychic|psychique|mental|mind/i, icon: ICONS.psychic },
  { re: /force( damage)?|dégâts de force/i, icon: ICONS.force },
  { re: /thunder|tonnerre/i, icon: ICONS.thunder },

  { re: /spell|sort|magique|magic|incant/i, icon: ICONS.magic },
  { re: /ranged|distance|bow|arc|arrow|flèche|bolt|ray/i, icon: ICONS.ranged },
  { re: /bite|morsure|claw|griffe|slam|coup|tail|queue|tentacle|pincers|pince/i, icon: ICONS.melee }
];

export function pickAbilityIcon(name = "", description = "") {
  const text = `${name}\n${description}`;
  for (const r of RULES) if (r.re.test(text)) return r.icon;
  return ICONS.generic;
}
