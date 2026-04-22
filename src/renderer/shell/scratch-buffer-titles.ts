/** Lowercase default scratch note title. */
export const SCRATCH_NOTE_BASE_TITLE = "scratch";

export type ScratchTitleSibling = {
  title: string;
  type: string;
  parentId: string | null;
};

const FRUITS = [
  "mango",
  "apple",
  "banana",
  "papaya",
  "guava",
  "lychee",
  "durian",
  "fig",
  "plum",
  "cherry",
] as const;

const VEGETABLES = [
  "kale",
  "spinach",
  "carrot",
  "beet",
  "okra",
  "yam",
  "chive",
  "leek",
  "radish",
  "turnip",
] as const;

const BIRDS = [
  "eagle",
  "falcon",
  "heron",
  "sparrow",
  "robin",
  "crane",
  "raven",
  "swift",
  "wren",
  "ibis",
] as const;

const ANIMALS = [
  "otter",
  "badger",
  "panda",
  "lynx",
  "moose",
  "bison",
  "coyote",
  "marten",
  "walrus",
  "gecko",
] as const;

const MOUNTAINS = [
  "everest",
  "rainier",
  "shasta",
  "blanc",
  "etna",
  "denali",
  "elbrus",
  "atlas",
  "olympus",
  "kenya",
] as const;

const RIVERS = [
  "nile",
  "amazon",
  "danube",
  "ganges",
  "rhine",
  "murray",
  "orinoco",
  "volga",
  "mekong",
  "yukon",
] as const;

const FORESTS = [
  "taiga",
  "boreal",
  "sequoia",
  "redwood",
  "taunus",
  "bwindi",
  "daintree",
  "sumatra",
  "valdivia",
  "kinabalu",
] as const;

const LAKES = [
  "baikal",
  "superior",
  "tanganyika",
  "malawi",
  "victoria",
  "titicaca",
  "huron",
  "geneva",
  "como",
  "winnipeg",
] as const;

const OCEANS = [
  "pacific",
  "atlantic",
  "indian",
  "arctic",
  "southern",
  "baltic",
  "coral",
  "arabian",
  "bering",
  "tasman",
] as const;

const SCRATCH_WORD_POOL: readonly string[] = [
  ...FRUITS,
  ...VEGETABLES,
  ...BIRDS,
  ...ANIMALS,
  ...MOUNTAINS,
  ...RIVERS,
  ...FORESTS,
  ...LAKES,
  ...OCEANS,
];

function titleKey(t: string): string {
  return t.trim().toLowerCase();
}

function pickWord(random: () => number): string {
  const pool = SCRATCH_WORD_POOL;
  const i = Math.floor(random() * pool.length);
  return pool[i] ?? pool[0]!;
}

/**
 * Next title for a new scratch note: `scratch`, or `scratch-<w1>-<w2>` when a same-type sibling
 * under the same parent already uses `scratch` (case-insensitive). Re-rolls random pairs until free.
 */
export function computeNextScratchNoteTitle(
  noteType: string,
  parentId: string | null,
  siblings: ScratchTitleSibling[],
  random: () => number = Math.random,
): string {
  const base = SCRATCH_NOTE_BASE_TITLE;
  const relevant = siblings.filter(
    (s) => s.type === noteType && s.parentId === parentId,
  );
  const used = new Set(relevant.map((s) => titleKey(s.title)));
  if (!used.has(base)) {
    return base;
  }
  const maxAttempts = 80;
  for (let i = 0; i < maxAttempts; i++) {
    const w1 = pickWord(random);
    const w2 = pickWord(random);
    const candidate = `${base}-${w1}-${w2}`;
    if (!used.has(titleKey(candidate))) {
      return candidate;
    }
  }
  return `${base}-${Math.floor(random() * 1e12)}`;
}
