export const MODULE_ID = "encounterplus-importer";

export const SETTINGS = {
  SOURCE_PATH: "sourcePath",
  IMPORT_DEST: "importDestination",
  PREFIX: "prefix"
};

export function t(key) {
  return game.i18n.localize(key);
}

export function log(...args) {
  console.log(`[${MODULE_ID}]`, ...args);
}

export function notify(type, message) {
  // type: info|warn|error
  ui.notifications[type]?.(message);
}
