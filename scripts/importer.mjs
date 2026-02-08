import { MODULE_ID, log, notify } from "./module.mjs";
import { scanEncounterPath } from "./diagnose.mjs";
import { pickAbilityIcon } from "./icon-map.mjs";

function safeInt(v, fallback = 0) {
  const n = parseInt(String(v ?? "").match(/-?\d+/)?.[0] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
function safeFloat(v, fallback = 0) {
  const n = parseFloat(String(v ?? "").match(/-?\d+(?:\.\d+)?/)?.[0] ?? "");
  return Number.isFinite(n) ? n : fallback;
}

// Convert a user-data relative path (e.g. encounter-source/foo/bar.webp)
// to a URL which respects Foundry's routing (reverse proxies, route prefix, etc.).
function toFilesUrl(dataPath, { absolute = false } = {}) {
  // Convert a user-data relative path (e.g. encounter-source/foo/bar.webp)
  // into a browser-loadable URL under Foundry's /files route, while respecting
  // any route prefix / reverse proxy (routePrefix like /game, /foundry, etc.).
  if (!dataPath) return null;

  const finalize = (route) => {
    if (!route) return null;
    const r = String(route).startsWith("/") ? String(route) : `/${route}`;
    return absolute ? new URL(r, window.location.origin).toString() : r;
  };

  const raw0 = String(dataPath).replace(/\\/g, "/").trim();
  if (!raw0) return null;
  if (/^(data:|https?:)/i.test(raw0)) return raw0;

  // Already a /files/... URL (maybe missing leading slash)
  if (raw0.startsWith("/files/")) return finalize(foundry.utils.getRoute(raw0));
  if (raw0.startsWith("files/")) return finalize(foundry.utils.getRoute(`/${raw0}`));

  // Strip leading slash and optional "data/" prefix
  let p = raw0.replace(/^\/+/, "");
  if (p.startsWith("data/")) p = p.slice("data/".length);

  // Static package paths
  const top = (p.split("/")[0] ?? "").toLowerCase();
  if (["modules", "systems", "worlds", "icons"].includes(top)) {
    return finalize(foundry.utils.getRoute(`/${p}`));
  }

  // User Data path: /<routePrefix>/files/data/<encoded path>
  const enc = p.split("/").map(encodeURIComponent).join("/");
  const filesBase = foundry.utils.getRoute("/files").replace(/\/+$/, "");
  return finalize(`${filesBase}/data/${enc}`);
}

function hasValidMediaExtension(path) {
  if (!path) return false;
  const s = String(path).split("?")[0].split("#")[0];
  return /\.(webp|png|jpe?g|gif|bmp|mp4|webm)$/i.test(s);
}

function hasValidImageExtension(path) {
  if (!path) return false;
  const s = String(path).split("?")[0].split("#")[0];
  return /\.(webp|png|jpe?g|gif|bmp|svg)$/i.test(s);
}


function normalizeDataPath(s) {
  if (!s) return null;
  const str = String(s);
  // Handle "files/data/..." without leading slash
  if (str.startsWith("files/data/")) return decodeURIComponent(str.slice("files/data/".length));
  // If we already have a plain data path like "encounter-source/.../file.png", keep it.
  if (!str.startsWith("http") && !str.startsWith("/files/")) return str.replace(/\\/g, "/").replace(/^\//, "");
  // Convert /files/data/<path> to <path>
  try {
    const u = new URL(str, window.location.origin);
    const p = u.pathname;
    const idx = p.indexOf("/files/data/");
    if (idx >= 0) return decodeURIComponent(p.slice(idx + "/files/data/".length));
    return decodeURIComponent(p.replace(/^\//, ""));
  } catch (e) {
    const idx = str.indexOf("/files/data/");
    if (idx >= 0) return str.slice(idx + "/files/data/".length);
    return str.replace(/^\//, "");
  }
}

function normalizeRelativePath(raw, basePath = "") {
  const s = String(raw ?? "").replace(/\\/g, "/").trim();
  if (!s) return "";
  const parts = s.split("/");
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  const normalized = out.join("/");
  if (s.startsWith("../") && basePath) {
    const base = String(basePath).replace(/^\/+/, "").replace(/\/+$/, "");
    const joined = `${base}/${normalized}`;
    return joined.replace(/\/+/g, "/");
  }
  return normalized;
}


function keyVariants(s) {
  const out = new Set();
  const add = (x) => {
    if (!x) return;
    out.add(String(x).toLowerCase());
  };

  const base = String(s ?? "");
  const norm = (x, form) => {
    try { return String(x).normalize(form); } catch (e) { return String(x); }
  };

  add(base);
  add(norm(base, "NFC"));
  add(norm(base, "NFD"));

  // Also add diacritic-stripped variants so composed/decomposed accents and weird
  // unicode forms resolve to the real on-disk filename.
  try {
    const stripped = norm(base, "NFKD").replace(/\p{M}/gu, "");
    add(stripped);
    add(norm(stripped, "NFC"));
    add(norm(stripped, "NFD"));
  } catch (e) {}

  // Collapse common separators (spaces / underscores / hyphens) for fuzzy matches.
  const snapshot = Array.from(out);
  for (const v of snapshot) add(String(v).replace(/[\s_-]+/g, ""));

  return [...out];
}


function indexAdd(index, key, entry) {
  for (const k of keyVariants(key)) {
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(entry);
  }
}

function indexGet(index, key) {
  if (!index || !key) return null;
  for (const k of keyVariants(key)) {
    const v = index.get(k);
    if (v?.length) return v;
  }
  return null;
}

async function buildFileIndex(basePath, { depth = 3, maxFiles = 25000 } = {}) {
  const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? FilePicker;
  // Map: keyLower -> [{ path }]
  // Keys include both full basename ("foo.webp") and stem ("foo") so we can resolve
  // Encounter+ references that omit the file extension.
  const index = new Map();
  const queue = [{ path: basePath, d: 0 }];
  let count = 0;

  while (queue.length) {
    const cur = queue.shift();
    let res;
    try {
      res = await FP.browse("data", cur.path);
    } catch (e) {
      log("Index browse failed", cur.path, e);
      continue;
    }

    for (const f of (res.files ?? [])) {
      const dataPath = normalizeDataPath(f);
      if (!dataPath) continue;
      const base = dataPath.split("/").pop() ?? "";
      indexAdd(index, base, { path: dataPath });

      // Also store the stem (basename without extension) as a key.
      const stem = base.replace(/\.[a-z0-9]{2,5}$/i, "");
      if (stem && stem !== base) indexAdd(index, stem, { path: dataPath });
      count++;
      if (count >= maxFiles) break;
    }
    if (count >= maxFiles) break;

    if (cur.d < depth) {
      for (const d of (res.dirs ?? [])) queue.push({ path: normalizeDataPath(d) ?? d, d: cur.d + 1 });
    }
  }
  return index;
}

function bestCandidate(cands, kind = "") {
  if (!cands?.length) return null;
  // Prefer deterministic + relevant folders.
  const prefer = (p) => {
    const s = p.toLowerCase();
    let score = 0;
    if (kind.startsWith("monster")) {
      if (s.includes("/monsters/")) score += 40;
      if (s.includes("/resources/monsters/")) score += 20;
    }
    if (kind.startsWith("item")) {
      if (s.includes("/items/")) score += 40;
      if (s.includes("/resources/items/")) score += 20;
    }
    if (kind.startsWith("map")) {
      if (s.includes("/maps/")) score += 20;
      // Root-level images are common for maps in exports
      if (s.split("/").length <= 3) score += 15;
    }
    // Prefer shorter paths (usually the canonical one)
    score += Math.max(0, 30 - s.length / 5);
    return score;
  };
  return [...cands].sort((a, b) => prefer(b.path) - prefer(a.path))[0].path;
}


async function ensureExtension(dataPath, fileIndex) {
  const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? FilePicker;
  if (!dataPath) return null;
  const p = String(dataPath).replace(/\\/g, "/").replace(/^\//, "");
  const leaf = p.split("/").pop() ?? p;
  if (/\.[a-z0-9]{2,5}$/i.test(leaf)) return p; // has extension
  // Fetch bytes and infer extension from the file signature.
  const url = toFilesUrl(p);
  if (!url) return p;
  let buf;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return p;
    buf = await resp.arrayBuffer();
  } catch (e) {
    return p;
  }
  const bytes = new Uint8Array(buf.slice(0, 16));
  const isPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isJpg = bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  const isGif = bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  const isWebp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const ext = isPng ? "png" : isWebp ? "webp" : isJpg ? "jpg" : isGif ? "gif" : "png";
  const mime = isPng ? "image/png" : isWebp ? "image/webp" : isJpg ? "image/jpeg" : isGif ? "image/gif" : "application/octet-stream";

  const dir = p.split("/").slice(0, -1).join("/");
  const newName = `${leaf}.${ext}`;
  const newPath = (dir ? `${dir}/${newName}` : newName).replace(/\/+/g, "/");

  // Upload only if missing. If upload fails, just return original path.
  try {
    const file = new File([buf], newName, { type: mime });
    await FP.upload("data", dir || "", file, { overwrite: false });
  } catch (e) {
    // If it already exists or cannot upload, we still try to use the newPath.
  }

  // Update index so future lookups find it.
  if (fileIndex && fileIndex instanceof Map) {
    indexAdd(fileIndex, newName, { path: newPath });
    indexAdd(fileIndex, leaf, { path: newPath });
  }
  return newPath;
}

function resolveAssetPath(basePath, fileIndex, name, { kind = "generic", allowNoExtension = false } = {}) {
  if (!name) return null;
  const raw0 = String(name).trim();
  if (!raw0) return null;
  const raw = normalizeRelativePath(raw0, basePath).replace(/^\//, "");
  if (/^(data:|https?:)/i.test(raw0)) return raw0;
  if (raw0.startsWith("/files/") || raw.startsWith("files/")) return normalizeDataPath(raw0);

  // If the reference is already a normal Foundry-static path, keep it.
  const top = (raw.split("/")[0] ?? "").toLowerCase();
  if (["modules", "systems", "worlds", "icons"].includes(top)) return raw;

  const segs = raw.split("/");
  const leaf = segs[segs.length - 1] ?? raw;
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(leaf);

  // If the reference already looks like a data-path rooted under the export folder, keep it.
  const bp = basePath.replace(/^\//, "").replace(/\/+$/, "");
  if (hasExt && (raw.startsWith(bp + "/") || raw.startsWith("encounter-source/"))) return raw;

  // 1) Try exact match (basename or stem) via the prebuilt index.
  const cands = indexGet(fileIndex, leaf);
  if (cands?.length) {
    // If the original ref had a folder, prefer candidates within that folder.
    const folderHint = raw.includes("/") ? segs.slice(0, -1).join("/").toLowerCase() : "";
    if (folderHint) {
      const filtered = cands.filter(c => (c.path ?? "").toLowerCase().includes(`/${folderHint}/`));
      if (filtered.length) return bestCandidate(filtered, kind);
    }
    return bestCandidate(cands, kind);
  }

  // 2) If the reference has an extension but we didn't find it (common: Encounter+ says .jpg but file is .webp),
  // try resolving by stem and by common extensions.
  if (hasExt) {
    const stem = leaf.replace(/\.[a-z0-9]{2,5}$/i, "");
    const stemCands = stem ? indexGet(fileIndex, stem) : null;
    if (stemCands?.length) return bestCandidate(stemCands, kind);
    const exts = ["webp", "png", "jpg", "jpeg", "gif", "mp4", "webm"]; 
    for (const ext of exts) {
      const c = indexGet(fileIndex, `${stem}.${ext}`);
      if (c?.length) return bestCandidate(c, kind);
    }

    // Fallback: treat as relative to export root (after giving the index a chance to resolve case/unicode differences)
    if (raw.includes("/")) {
      return `${basePath.replace(/^\//, "")}/${raw}`.replace(/\/+/g, "/");
    }
  }

  // 3) If missing extension, try common ones.
  if (!hasExt) {
    const exts = ["webp", "png", "jpg", "jpeg", "gif", "mp4", "webm"]; 
    for (const ext of exts) {
      const c = indexGet(fileIndex, `${leaf}.${ext}`);
      if (c?.length) return bestCandidate(c, kind);
    }
    if (!allowNoExtension) return null;
  }

  // 4) Conservative fallback guesses (folder heuristics).
  const k = String(kind).toLowerCase();
  const bp2 = String(basePath).replace(/^\//, "").replace(/\/+$/, "");
  const guesses = [];
  const push = (p) => guesses.push(String(p).replace(/\/+/g, "/"));

  // When Encounter+ stores only a filename, it is usually located in a subfolder (monsters/, items/, Images/, ...).
  if (k.includes("monster")) {
    push(`${bp2}/monsters/${leaf}`);
    push(`${bp2}/resources/monsters/${leaf}`);
    push(`${bp2}/${leaf}`);
  } else if (k.includes("item")) {
    push(`${bp2}/items/${leaf}`);
    push(`${bp2}/resources/items/${leaf}`);
    push(`${bp2}/${leaf}`);
  } else if (k.includes("page") || k.includes("journal")) {
    if (raw.includes("/")) push(`${bp2}/${raw}`);
    push(`${bp2}/Images/${raw}`);
    push(`${bp2}/Images/${leaf}`);
    push(`${bp2}/${leaf}`);
  } else if (k.includes("map")) {
    if (raw.includes("/")) push(`${bp2}/${raw}`);
    push(`${bp2}/${leaf}`);
    push(`${bp2}/maps/${leaf}`);
    push(`${bp2}/Images/${leaf}`);
  } else {
    if (raw.includes("/")) push(`${bp2}/${raw}`);
    push(`${bp2}/${leaf}`);
    push(`${bp2}/Images/${leaf}`);
    push(`${bp2}/maps/${leaf}`);
    push(`${bp2}/monsters/${leaf}`);
    push(`${bp2}/items/${leaf}`);
  }

  return guesses[0] ?? `${bp2}/${leaf}`;
}


function rewriteHtml(content, basePath, fileIndex) {
  if (!content) return "";
  let html = String(content);

  // Support Markdown-style images if any slipped into JSON exports.
  html = html.replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, (m, alt, src) => {
    const a = String(alt ?? "").replace(/"/g, "&quot;");
    const s = String(src ?? "").trim();
    return `<img alt="${a}" src="${s}">`;
  });

  // Use DOM parsing for robust attribute rewriting.
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const fixUrl = (u, kind = "page-image", allowNoExtension = true) => {
      if (!u) return u;
      const src = String(u).trim();
      if (!src) return src;
      if (/^(data:|https?:)/i.test(src)) return src;
      if (src.startsWith("/files/")) return toFilesUrl(src, { absolute: true });
      if (src.startsWith("files/")) return toFilesUrl(src, { absolute: true });
      const fixed = resolveAssetPath(basePath, fileIndex, src, { kind, allowNoExtension });
      return fixed ? toFilesUrl(fixed, { absolute: true }) : src;
    };

    // <img>
    for (const el of Array.from(doc.querySelectorAll("img"))) {
      if (el.hasAttribute("src")) el.setAttribute("src", fixUrl(el.getAttribute("src"), "page-image", true));
      for (const a of ["data-src", "data-lazy-src", "data-original"]) {
        if (el.hasAttribute(a)) el.setAttribute(a, fixUrl(el.getAttribute(a), "page-image", true));
      }
    }

    // <source srcset="...">
    for (const el of Array.from(doc.querySelectorAll("source"))) {
      if (el.hasAttribute("srcset")) {
        const srcset = String(el.getAttribute("srcset") ?? "");
        const parts = srcset.split(",").map(p => p.trim()).filter(Boolean);
        const fixedParts = parts.map(p => {
          const m = p.match(/^(\S+)(\s+.+)?$/);
          if (!m) return p;
          return `${fixUrl(m[1], "page-image", true)}${m[2] ?? ""}`;
        });
        el.setAttribute("srcset", fixedParts.join(", "));
      }
    }

    // style="background-image: url(...)" etc.
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      const style = String(el.getAttribute("style") ?? "");
      if (!style.includes("url(")) continue;
      const fixed = style.replace(/url\(([^\)]+)\)/gi, (m, inner) => {
        const raw = String(inner).trim().replace(/^['"]|['"]$/g, "");
        const u = fixUrl(raw, "page-image", true);
        return `url('${u}')`;
      });
      el.setAttribute("style", fixed);
    }

    return doc.body.innerHTML;
  } catch (e) {
    // Fallback: a simple src rewrite.
    return html.replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (m, p1, src, p3) => {
      if (/^(data:|https?:|\/files\/)/i.test(src)) return m;
      const fixed = resolveAssetPath(basePath, fileIndex, src, { kind: "page-image", allowNoExtension: true });
      const finalSrc = fixed ? toFilesUrl(fixed, { absolute: true }) : src;
      return `${p1}${finalSrc}${p3}`;
    });
  }
}

export async function repairJournalImages({ sourcePath, prefix = "Encounter+ Import" } = {}) {
  if (!sourcePath) {
    notify("warn", "Chemin source vide.");
    return;
  }

  notify("info", "Réparation des images dans les journaux…");

  const scan = await scanEncounterPath(sourcePath, { depth: 2 });
  const basePath = scan.basePath;

  // Deep scan: journals often reference Images/ and other nested folders.
  const fileIndex = await buildFileIndex(basePath, { depth: 6 });

  const folderName = `${prefix} - Journaux`;
  const folder = game.folders?.find(f => f.type === "JournalEntry" && f.name === folderName && !f.folder);
  const journals = game.journal?.filter(j => (folder ? j.folder?.id === folder.id : (j.folder?.name === folderName))) ?? [];

  let entriesTouched = 0;
  let pagesTouched = 0;
  let pagesUnchanged = 0;

  for (const je of journals) {
    let touchedThisEntry = false;
    const pages = je.pages?.contents ?? [];
    for (const page of pages) {
      if (page.type !== "text") continue;
      const original = page.text?.content ?? "";
      const rewritten = rewriteHtml(original, basePath, fileIndex);
      if (rewritten !== original) {
        await page.update({ text: { content: rewritten } });
        pagesTouched++;
        touchedThisEntry = true;
      } else {
        pagesUnchanged++;
      }
    }
    if (touchedThisEntry) entriesTouched++;
  }

  notify("info", `Journaux réparés ✅ Entrées: ${entriesTouched} | Pages modifiées: ${pagesTouched} | Pages inchangées: ${pagesUnchanged}`);
}


async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON parse error for ${url}: ${e.message}`);
  }
}

async function ensureFolder(type, name) {
  const existing = game.folders?.find(f => f.type === type && f.name === name && !f.folder);
  if (existing) return existing;
  return Folder.create({ name, type });
}

function buildFeat(name, text) {
  return {
    name,
    type: "feat",
    img: pickAbilityIcon(name, text),
    system: {
      description: { value: text ?? "" }
    },
    flags: { [MODULE_ID]: { kind: "ability" } }
  };
}

function roundTo5(n) {
  return Math.round(n / 5) * 5;
}

function metersToFeet(m) {
  return roundTo5(m * 3.28084);
}

function crToNumber(crRaw) {
  const s = String(crRaw ?? "0").trim();
  if (!s) return 0;
  if (s.includes("/")) {
    const [a, b] = s.split("/").map(n => parseFloat(n));
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function pbFromCr(crNum) {
  if (crNum >= 29) return 9;
  if (crNum >= 25) return 8;
  if (crNum >= 21) return 7;
  if (crNum >= 17) return 6;
  if (crNum >= 13) return 5;
  if (crNum >= 9) return 4;
  if (crNum >= 5) return 3;
  return 2;
}

const SKILL_KEY_TO_DND5E = {
  acrobatics: "acr",
  animalHandling: "ani",
  arcana: "arc",
  athletics: "ath",
  deception: "dec",
  history: "his",
  insight: "ins",
  intimidation: "itm",
  investigation: "inv",
  medicine: "med",
  nature: "nat",
  perception: "prc",
  performance: "prf",
  persuasion: "per",
  religion: "rel",
  sleightOfHand: "slt",
  stealth: "ste",
  survival: "sur"
};

const SKILL_KEY_TO_ABILITY = {
  acr: "dex",
  ani: "wis",
  arc: "int",
  ath: "str",
  dec: "cha",
  his: "int",
  ins: "wis",
  itm: "cha",
  inv: "int",
  med: "wis",
  nat: "int",
  prc: "wis",
  prf: "cha",
  per: "cha",
  rel: "int",
  slt: "dex",
  ste: "dex",
  sur: "wis"
};

function abilityMod(score) {
  const s = safeInt(score, 10);
  return Math.floor((s - 10) / 2);
}

function mapSkills(skillsObj, abilitiesObj, crRaw) {
  if (!skillsObj || typeof skillsObj !== "object") return null;
  const crNum = crToNumber(crRaw);
  const pb = pbFromCr(crNum);
  const out = {};

  for (const [k, total] of Object.entries(skillsObj)) {
    const abbr = SKILL_KEY_TO_DND5E[k] ?? null;
    if (!abbr) continue;
    const abil = SKILL_KEY_TO_ABILITY[abbr] ?? null;
    const base = abil ? abilityMod(abilitiesObj?.[abil] ?? 10) : 0;
    const tgt = safeInt(total, 0);
    const diff = tgt - base;

    let value = 0;
    let bonus = 0;
    if (Math.abs(diff - pb) <= 0.75) {
      value = 1;
      bonus = diff - pb;
    } else if (Math.abs(diff - 2 * pb) <= 0.75) {
      value = 2;
      bonus = diff - 2 * pb;
    } else if (Math.abs(diff) <= 0.75) {
      value = 0;
      bonus = diff;
    } else {
      // Fallback: assume proficient and store the remainder as bonus
      value = 1;
      bonus = diff - pb;
    }

    out[abbr] = { value, bonus: Math.round(bonus) };
  }

  return Object.keys(out).length ? out : null;
}

function speedExpr(v, measurement) {
  // dnd5e 5.2+ validates speeds as "safe expressions" (string).
  // Encounter+ exports metric speeds as meters (e.g. 9m = 30ft).
  let n = 0;
  if (typeof v === "number") n = v;
  else n = safeFloat(v, 0);

  // Convert metric -> feet for maximum compatibility (avoids relying on dnd5e metric setting).
  if (String(measurement).toLowerCase() === "metric") n = metersToFeet(n);

  // Always return a clean expression string (no brackets, no objects).
  return String(Math.max(0, Math.round(n)));
}

async function getImageDimensions(url) {
  if (!url) return null;
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function pickFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && `${v}` !== "") return v;
  }
  return null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function parseActivationType(text = "") {
  const s = String(text).toLowerCase();
  if (!s) return "none";
  if (/(^|\b)(bonus|action bonus|bonus action|action bonus)/.test(s)) return "bonus";
  if (/(^|\b)(reaction|réaction)/.test(s)) return "reaction";
  if (/(^|\b)(legendary|légendaire)/.test(s)) return "legendary";
  if (/(^|\b)(lair|repaire)/.test(s)) return "lair";
  if (/(^|\b)(action|attaque)/.test(s)) return "action";
  return "none";
}

function parseTraitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v).split(/[;,\n]+/).map(x => x.trim()).filter(Boolean);
}

function toNpc(mon, basePath, fileIndex, folderId) {
  const d = mon.data ?? {};
  const measurement = mon.attributes?.measurement ?? "";
  const ab = d.abilities ?? {};
  const ac = safeInt(d.ac, 10);
  const hp = safeInt(d.hp, 1);
  const sp = d.speed ?? {};
  const crRaw = d.cr ?? "0";
  const crNum = crToNumber(crRaw);

  // dnd5e schema expects movement speeds as string expressions, not nested objects.
  const movement = {
    walk: speedExpr(sp.walk ?? sp.speed ?? 0, measurement),
    climb: speedExpr(sp.climb ?? 0, measurement),
    fly: speedExpr(sp.fly ?? 0, measurement),
    swim: speedExpr(sp.swim ?? 0, measurement),
    burrow: speedExpr(sp.burrow ?? 0, measurement)
  };

  const items = [];
  for (const a of (d.traits ?? [])) {
    items.push({
      ...buildFeat(a.name ?? "Trait", a.text ?? ""),
      system: { description: { value: a.text ?? "" }, activation: { type: "none", cost: 0 } }
    });
  }
  for (const a of (d.actions ?? [])) {
    const text = a.text ?? "";
    items.push({
      ...buildFeat(a.name ?? "Action", text),
      system: { description: { value: text }, activation: { type: parseActivationType(a.activation ?? "action"), cost: 1 } }
    });
  }
  for (const a of (d.reactions ?? [])) {
    const text = a.text ?? "";
    items.push({
      ...buildFeat(a.name ?? "Réaction", text),
      system: { description: { value: text }, activation: { type: "reaction", cost: 1 } }
    });
  }
  for (const a of (d.legendary ?? d.legendaryActions ?? [])) {
    const text = a.text ?? "";
    items.push({
      ...buildFeat(a.name ?? "Légendaire", text),
      system: { description: { value: text }, activation: { type: "legendary", cost: safeInt(a.cost, 1) } }
    });
  }

  const tokenImgResolved = resolveAssetPath(basePath, fileIndex, mon.token, { kind: "monster-token", allowNoExtension: true });
  const actorImgResolved = resolveAssetPath(basePath, fileIndex, mon.image, { kind: "monster-image", allowNoExtension: true });

  let actorImg = actorImgResolved ?? tokenImgResolved;
  let tokenImg = tokenImgResolved ?? actorImgResolved;

  // Ensure Foundry validations are happy.
  if (!hasValidImageExtension(actorImg)) actorImg = "icons/svg/mystery-man.svg";
  if (!hasValidImageExtension(tokenImg)) tokenImg = actorImg;
  actorImg = toFilesUrl(actorImg) ?? actorImg;
  tokenImg = toFilesUrl(tokenImg) ?? tokenImg;


  const sizeCode = String(d.size ?? "").toUpperCase();
  const size = sizeCode === "S" ? "sm" : sizeCode === "T" ? "tiny" : sizeCode === "L" ? "lg" : "med";

  const mappedSkills = mapSkills(d.skills, ab, crRaw);

  // Senses: Encounter+ exports numeric values (often meters). We store in ft for consistency.
  const sensesIn = d.senses ?? {};
  const sensesOut = {};
  for (const [k, v] of Object.entries(sensesIn)) {
    const n = safeFloat(v, 0);
    const ft = (String(measurement).toLowerCase() === "metric") ? metersToFeet(n) : n;
    sensesOut[k] = Math.round(ft);
  }

  return {
    name: mon.name ?? "NPC",
    type: "npc",
    img: actorImg,
    folder: folderId,
    prototypeToken: {
      name: mon.name ?? "NPC",
      texture: { src: tokenImg },
      actorLink: false
    },
    system: {
      abilities: {
        str: { value: safeInt(ab.str, 10) },
        dex: { value: safeInt(ab.dex, 10) },
        con: { value: safeInt(ab.con, 10) },
        int: { value: safeInt(ab.int, 10) },
        wis: { value: safeInt(ab.wis, 10) },
        cha: { value: safeInt(ab.cha, 10) }
      },
      attributes: {
        ac: { value: ac },
        hp: { value: hp, max: hp },
        movement,
        senses: sensesOut
      },
      details: {
        cr: crNum,
        type: { value: d.type ?? "" },
        alignment: d.alignment ?? "",
        biography: { value: d.description ?? "" }
      },
      traits: {
        size,
        languages: { custom: d.languages ?? "" },
        di: { value: parseTraitList(d.damageImmunities ?? d.immunities), custom: "" },
        dr: { value: parseTraitList(d.damageResistances ?? d.resistances), custom: "" },
        dv: { value: parseTraitList(d.damageVulnerabilities ?? d.vulnerabilities), custom: "" },
        ci: { value: parseTraitList(d.conditionImmunities), custom: "" }
      },
      ...(mappedSkills ? { skills: mappedSkills } : {})
    },
    items,
    flags: { [MODULE_ID]: { kind: "monster", id: mon.id, slug: mon.slug } }
  };
}

function toLootItem(it, basePath, fileIndex, folderId) {
  const imgResolved = resolveAssetPath(basePath, fileIndex, it.image, { kind: "item-image", allowNoExtension: true });
  const img0 = hasValidImageExtension(imgResolved) ? imgResolved : "icons/svg/item-bag.svg";
  const img = toFilesUrl(img0) ?? img0;
  const quantity = safeInt(pickFirst(it.quantity, it.qty, it.count), 1);
  const weight = safeFloat(pickFirst(it.weight, it.mass), 0);
  const charges = safeInt(pickFirst(it.charges, it.uses?.max), 0);
  const currentCharges = safeInt(pickFirst(it.uses?.value, charges), charges);
  const priceValue = safeFloat(pickFirst(it.value, it.price, it.cost), 0);
  const description = pickFirst(it.descr, it.description, "") ?? "";
  return {
    name: it.name ?? "Item",
    type: "loot",
    img,
    folder: folderId,
    system: {
      description: { value: description },
      quantity,
      weight,
      price: { value: priceValue, denomination: "gp" },
      uses: { value: currentCharges, max: charges, per: "charges" }
    },
    flags: { [MODULE_ID]: { kind: "item", id: it.id, slug: it.slug } }
  };
}

function toJournal(page, basePath, fileIndex, folderId) {
  const content = rewriteHtml(page.content ?? "", basePath, fileIndex);
  return {
    name: page.name ?? "Page",
    folder: folderId,
    pages: [{
      name: page.name ?? "Page",
      type: "text",
      text: { content }
    }],
    flags: { [MODULE_ID]: { kind: "page", id: page.id, slug: page.slug } }
  };
}

function mapGridType(map) {
  const gt = String(map.gridType ?? "").toLowerCase();
  if (gt.includes("hex")) return 2; // coarse mapping; square exports use "square"
  return 1;
}

async function toSceneAsync(map, basePath, fileIndex, folderId) {
  // Prefer the full map image. Encounter+ "floor" assets in some exports are tiny icons.
  let bgPath =
    resolveAssetPath(basePath, fileIndex, map.image, { kind: "map-image", allowNoExtension: true }) ??
    resolveAssetPath(basePath, fileIndex, map.floor, { kind: "map-floor", allowNoExtension: true });
  // Ensure textures have an extension for Foundry validation.
  bgPath = await ensureExtension(bgPath, fileIndex);
  // If the file still has no extension (some servers refuse to serve extensionless files), try resolving by stem.
  if (bgPath) {
    const leaf = String(bgPath).split("/").pop() ?? "";
    if (!/\.[a-z0-9]{2,5}$/i.test(leaf)) {
      const alt = resolveAssetPath(basePath, fileIndex, leaf, { kind: "map-image", allowNoExtension: false });
      if (alt) bgPath = alt;
    }
  }
  const bgSrc0 = (bgPath && hasValidMediaExtension(bgPath)) ? bgPath : null;
  const bgSrc = bgSrc0 ? (toFilesUrl(bgSrc0) ?? bgSrc0) : null;
  const bgUrl = bgSrc ? toFilesUrl(bgSrc) : null;
  const gridSize = safeInt(map.gridSize, 100);
  const units = map.gridUnits ?? "ft";
  const distance = safeFloat(map.gridScale, (String(units).toLowerCase() === "m" ? 1.5 : 5));

  let width = safeInt(map.width, 0);
  let height = safeInt(map.height, 0);

  // Some Encounter+ exports store width/height as 0; try to read from image.
  if ((width <= 0 || height <= 0) && bgUrl) {
    const dim = await getImageDimensions(bgUrl);
    if (dim?.width > 0 && dim?.height > 0) {
      width = dim.width;
      height = dim.height;
    }
  }

  // Final fallback to safe positive values.
  if (width <= 0) width = 3000;
  if (height <= 0) height = 2000;

  // Tiles (only those with a valid image extension)
  const tiles = [];
  for (const t of (map.tiles ?? [])) {
    const res = t?.asset?.resource;
    let src = resolveAssetPath(basePath, fileIndex, res, { kind: "map-tile", allowNoExtension: true });
    if (!src) continue;
    src = await ensureExtension(src, fileIndex);
    // If the tile is still extensionless after ensureExtension, Foundry will reject it.
    const leaf2 = String(src).split("/").pop() ?? "";
    if (!/\.[a-z0-9]{2,5}$/i.test(leaf2) || !hasValidMediaExtension(src)) {
      log("Skip tile (no extension)", map?.name, res);
      continue;
    }
    const w = safeInt(t.width, 0);
    const h = safeInt(t.height, 0);
    const sc = safeFloat(t.scale, 1);
    if (w <= 0 || h <= 0) continue;
    src = toFilesUrl(src) ?? src;
    tiles.push({
      x: safeInt(t.x, 0),
      y: safeInt(t.y, 0),
      width: Math.max(1, Math.round(w * sc)),
      height: Math.max(1, Math.round(h * sc)),
      rotation: safeFloat(t.rotation, 0),
      alpha: Math.min(1, Math.max(0, safeFloat(t.opacity, 1))),
      hidden: !!t.hidden,
      texture: { src }
    });
  }

  const walls = [];
  for (const w of asArray(map.walls ?? map.lines ?? map.wallSegments)) {
    const c = Array.isArray(w?.c)
      ? w.c
      : [pickFirst(w?.x, w?.x1), pickFirst(w?.y, w?.y1), pickFirst(w?.x2, w?.xEnd), pickFirst(w?.y2, w?.yEnd)];
    const coords = c.map(v => safeInt(v, 0));
    if (coords.length !== 4) continue;
    if ((coords[0] === coords[2]) && (coords[1] === coords[3])) continue;
    walls.push({
      c: coords,
      move: safeInt(w?.move, w?.movement ?? 20),
      sight: safeInt(w?.sight, w?.vision ?? 20),
      sound: safeInt(w?.sound, 20),
      door: safeInt(w?.door, 0),
      ds: safeInt(w?.ds, 0),
      dir: safeInt(w?.dir, 0)
    });
  }

  return {
    name: map.name ?? "Map",
    folder: folderId,
    width,
    height,
    ...(bgSrc ? { background: { src: bgSrc } } : {}),
    tiles,
    walls,
    grid: {
      size: gridSize,
      distance,
      units,
      type: mapGridType(map),
      color: map.gridColor ?? "#000000",
      alpha: safeFloat(map.gridOpacity, 0.2),
      offsetX: safeInt(map.gridOffsetX, 0),
      offsetY: safeInt(map.gridOffsetY, 0)
    },
    flags: { [MODULE_ID]: { kind: "map", id: map.id, slug: map.slug } }
  };
}

function toRollTable(t, folderId) {
  const rows = t.rows ?? [];
  const formula = (t.rolls?.[0]?.formula) || `1d${Math.max(rows.length, 1)}`;
  const results = rows.map((r, i) => {
    const min = safeInt(pickFirst(r?.range?.[0], r?.min, r?.from, i + 1), i + 1);
    const max = safeInt(pickFirst(r?.range?.[1], r?.max, r?.to, min), min);
    const text = String(pickFirst(r?.text, r?.[2], r?.result, r?.[0], "")).trim();
    const weight = safeInt(pickFirst(r?.weight, 1), 1);
    return {
      type: 0,
      text,
      range: [min, Math.max(min, max)],
      weight,
      drawn: false
    };
  });
  return {
    name: t.name ?? "Table",
    folder: folderId,
    formula,
    results,
    flags: { [MODULE_ID]: { kind: "table", id: t.id, slug: t.slug } }
  };
}

export async function runImport({ sourcePath, prefix = "Encounter+ Import", destination = "world" } = {}) {
  if (!sourcePath) {
    notify("warn", "Chemin source vide.");
    return;
  }

  notify("info", `Import Encounter+ : analyse de ${sourcePath}...`);
  const scan = await scanEncounterPath(sourcePath, { depth: 2 });
  const basePath = scan.basePath;
  const found = scan.found;

  // Build a small index of files under the export folder, used to resolve images (monsters/items/tokens/maps).
  notify("info", "Indexation des fichiers (pour résoudre les images)…");
  const fileIndex = await buildFileIndex(basePath, { depth: 4 });
  log("File index keys:", fileIndex?.size ?? 0);

  const summary = { pages:0, maps:0, monsters:0, items:0, tables:0 };
  const failed = { pages:0, maps:0, monsters:0, items:0, tables:0 };
  const firstErrors = [];
  log("Scan basePath:", basePath, "found:", Array.from(found.keys()));

  const jsonUrl = (name) => found.get(name)?.url ?? null;

  // Prefer JSON
  const pagesUrl = jsonUrl("pages.json");
  const mapsUrl = jsonUrl("maps.json");
  const monstersUrl = jsonUrl("monsters.json");
  const itemsUrl = jsonUrl("items.json");
  const tablesUrl = jsonUrl("tables.json");

  if (!pagesUrl && !mapsUrl && !monstersUrl && !itemsUrl && !tablesUrl) {
    notify("error", `Aucun fichier JSON détecté dans ${sourcePath}. (XML non supporté dans cette version)`);
    return;
  }

  // Load data (if missing, use empty arrays)
  const pages = pagesUrl ? await fetchJson(pagesUrl) : [];
  const maps = mapsUrl ? await fetchJson(mapsUrl) : [];
  const monsters = monstersUrl ? await fetchJson(monstersUrl) : [];
  const items = itemsUrl ? await fetchJson(itemsUrl) : [];
  const tables = tablesUrl ? await fetchJson(tablesUrl) : [];

  // Use basePath for assets resolution
  const assetBase = basePath;

  // Create folders
  const fJournal = await ensureFolder("JournalEntry", `${prefix} - Journaux`);
  const fScene = await ensureFolder("Scene", `${prefix} - Scènes`);
  const fActor = await ensureFolder("Actor", `${prefix} - Monstres`);
  const fItem = await ensureFolder("Item", `${prefix} - Objets`);
  const fTable = await ensureFolder("RollTable", `${prefix} - Tables`);

  notify("info", `Import en cours… (journaux=${pages.length}, scènes=${maps.length}, monstres=${monsters.length}, objets=${items.length}, tables=${tables.length})`);

  // Import Journals
  for (const p of pages) {
    try {
      await JournalEntry.create(toJournal(p, assetBase, fileIndex, fJournal.id));
      summary.pages++;
    } catch (e) {
      log("Journal import failed", p?.name, e);
      failed.pages++;
      if (firstErrors.length < 5) firstErrors.push(`Journal: ${p?.name ?? "(sans nom)"} → ${e?.message ?? e}`);
    }
  }

  // Import Scenes
  for (const m of maps) {
    try {
      const data = await toSceneAsync(m, assetBase, fileIndex, fScene.id);
      await Scene.create(data);
      summary.maps++;
    } catch (e) {
      log("Scene import failed", m?.name, e);
      failed.maps++;
      if (firstErrors.length < 5) firstErrors.push(`Scène: ${m?.name ?? "(sans nom)"} → ${e?.message ?? e}`);
    }
  }

  // Import Monsters
  for (const mon of monsters) {
    try {
      await Actor.create(toNpc(mon, assetBase, fileIndex, fActor.id));
      summary.monsters++;
    } catch (e) {
      log("Monster import failed", mon?.name, e);
      failed.monsters++;
      if (firstErrors.length < 5) firstErrors.push(`Monstre: ${mon?.name ?? "(sans nom)"} → ${e?.message ?? e}`);
    }
  }

  // Import Items
  for (const it of items) {
    try {
      await Item.create(toLootItem(it, assetBase, fileIndex, fItem.id));
      summary.items++;
    } catch (e) {
      log("Item import failed", it?.name, e);
      failed.items++;
      if (firstErrors.length < 5) firstErrors.push(`Objet: ${it?.name ?? "(sans nom)"} → ${e?.message ?? e}`);
    }
  }

  // Import Tables
  for (const t of tables) {
    try {
      await RollTable.create(toRollTable(t, fTable.id));
      summary.tables++;
    } catch (e) {
      log("Table import failed", t?.name, e);
      failed.tables++;
      if (firstErrors.length < 5) firstErrors.push(`Table: ${t?.name ?? "(sans nom)"} → ${e?.message ?? e}`);
    }
  }

  const ok = `Journaux:${summary.pages} | Scènes:${summary.maps} | Monstres:${summary.monsters} | Objets:${summary.items} | Tables:${summary.tables}`;
  const ko = `échecs → Journaux:${failed.pages} | Scènes:${failed.maps} | Monstres:${failed.monsters} | Objets:${failed.items} | Tables:${failed.tables}`;
  notify("info", `Import terminé ✅ ${ok} (${ko})`);
  if (firstErrors.length) {
    notify("warn", `Quelques erreurs (voir Console F12 pour tout) :\n- ${firstErrors.join("\n- ")}`);
  }
  log("Import summary:", summary);
  log("Import failed:", failed);
  if (firstErrors.length) log("First errors:", firstErrors);
}
