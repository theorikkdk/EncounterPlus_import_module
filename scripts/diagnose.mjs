import { log } from "./module.mjs";

const WANTED = new Set([
  "module.xml","compendium.xml",
  "pages.json","maps.json","monsters.json","items.json","tables.json","groups.json","module.json"
]);


const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;

function basenameFromAny(s) {
  try {
    const u = new URL(s, window.location.origin);
    return decodeURIComponent(u.pathname.split("/").pop() || "");
  } catch(e) {
    return decodeURIComponent(String(s).split("/").pop() || "");
  }
}

export async function scanEncounterPath(rootPath, { depth = 2 } = {}) {
  const source = "data";
  const queue = [{ path: rootPath, d: 0 }];
  const found = new Map(); // name -> { url, dir }

  while (queue.length) {
    const cur = queue.shift();
    let res;
    try {
      res = await FP.browse(source, cur.path);
    } catch (e) {
      log("Browse failed", cur.path, e);
      continue;
    }

    for (const f of (res.files ?? [])) {
      const b = basenameFromAny(f);
      if (WANTED.has(b) && !found.has(b)) found.set(b, { url: f, dir: cur.path });
    }

    if (cur.d < depth) {
      for (const d of (res.dirs ?? [])) queue.push({ path: d, d: cur.d + 1 });
    }
  }

  // pick best base dir: prefer where module.xml lives else where pages.json lives else rootPath
  const base =
    found.get("module.xml")?.dir ??
    found.get("pages.json")?.dir ??
    found.get("compendium.xml")?.dir ??
    rootPath;

  return { basePath: base, found };
}
