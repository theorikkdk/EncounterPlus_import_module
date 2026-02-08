import { MODULE_ID, SETTINGS, t } from "./module.mjs";
import { runImport, repairJournalImages } from "./importer.mjs";
import { scanEncounterPath } from "./diagnose.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class EncounterImporterApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "encounterplus-importer",
    tag: "form",
    window: {
      title: "EPI.App.Title",
      icon: "fas fa-file-import",
      resizable: true
    },
    position: { width: 720, height: "auto" },
    actions: {
      browse: this.#onBrowse,
      test: this.#onTest,
      import: this.#onImport,
      repairJournals: this.#onRepairJournals
    },
    form: { closeOnSubmit: false, submitOnChange: false, handler: () => {} }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/importer.hbs` }
  };

  async _prepareContext() {
    return {
      sourcePath: game.settings.get(MODULE_ID, SETTINGS.SOURCE_PATH) || "",
      prefix: game.settings.get(MODULE_ID, SETTINGS.PREFIX) || "Encounter+ Import",
      destination: game.settings.get(MODULE_ID, SETTINGS.IMPORT_DEST) || "world"
    };
  }

  static async #onBrowse(event) {
    event.preventDefault();
    const input = this.element.querySelector("input[name='sourcePath']");
    const current = input?.value || "";
    const FP = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    new FP({
      type: "folder",
      current,
      callback: (path) => input.value = path
    }).render(true);
  }

  static async #onTest(event) {
    event.preventDefault();
    const input = this.element.querySelector("input[name='sourcePath']");
    const sourcePath = input?.value?.trim() || "";
    if (!sourcePath) return ui.notifications.warn("Chemin source vide.");

    ui.notifications.info("Vérification Encounter+ : recherche de fichiers…");
    const scan = await scanEncounterPath(sourcePath, { depth: 2 });
    const files = Array.from(scan.found.keys()).sort().join(", ");
    if (!files) {
      ui.notifications.error(`Aucun fichier Encounter+ détecté dans : ${sourcePath}`);
      return;
    }
    ui.notifications.info(`Fichiers détectés (base=${scan.basePath}) : ${files}`);
    ui.notifications.info("Test terminé ✅ (prochaine étape : import complet)");
  }

  static async #onImport(event) {
    event.preventDefault();
    const sourcePath = this.element.querySelector("input[name='sourcePath']")?.value?.trim() || "";
    const prefix = this.element.querySelector("input[name='prefix']")?.value?.trim() || "Encounter+ Import";
    const destination = this.element.querySelector("select[name='destination']")?.value || "world";

    await game.settings.set(MODULE_ID, SETTINGS.SOURCE_PATH, sourcePath);
    await game.settings.set(MODULE_ID, SETTINGS.PREFIX, prefix);
    await game.settings.set(MODULE_ID, SETTINGS.IMPORT_DEST, destination);

    await runImport({ sourcePath, prefix, destination });
  }

  static async #onRepairJournals(event) {
    event.preventDefault();
    const sourcePath = this.element.querySelector("input[name='sourcePath']")?.value?.trim() || "";
    const prefix = this.element.querySelector("input[name='prefix']")?.value?.trim() || "Encounter+ Import";

    await game.settings.set(MODULE_ID, SETTINGS.SOURCE_PATH, sourcePath);
    await game.settings.set(MODULE_ID, SETTINGS.PREFIX, prefix);

    await repairJournalImages({ sourcePath, prefix });
  }
}
