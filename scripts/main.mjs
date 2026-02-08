import { MODULE_ID, SETTINGS } from "./module.mjs";
import { EncounterImporterApp } from "./ui.mjs";

Hooks.once("init", () => {
  // NOTE: At least one config-visible setting is required for the module to appear in Foundry's Settings UI.
  game.settings.register(MODULE_ID, SETTINGS.SOURCE_PATH, {
    name: "EPI.Settings.SourcePath.Name",
    hint: "EPI.Settings.SourcePath.Hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.PREFIX, {
    name: "EPI.Settings.Prefix.Name",
    hint: "EPI.Settings.Prefix.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "Encounter+ Import"
  });

  game.settings.register(MODULE_ID, SETTINGS.IMPORT_DEST, {
    name: "EPI.Settings.Destination.Name",
    hint: "EPI.Settings.Destination.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      world: "World"
    },
    default: "world"
  });

  game.settings.registerMenu(MODULE_ID, "importer", {
    name: "EPI.Menu.Name",
    label: "EPI.Menu.Label",
    hint: "EPI.Menu.Hint",
    icon: "fas fa-file-import",
    type: EncounterImporterApp,
    restricted: true
  });
});

// Helpful runtime confirmation: show which version is actually loaded.
Hooks.once("ready", () => {
  const mod = game.modules?.get?.(MODULE_ID);
  const v = mod?.version ?? "(unknown)";
  console.log(`[${MODULE_ID}] Loaded version`, v);
  if (game.user?.isGM) ui.notifications?.info?.(`Encounter+ Importer v${v} chargé.`);
});
