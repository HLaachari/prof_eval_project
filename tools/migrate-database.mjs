import "dotenv/config";
import { createDatabase, databaseSettings } from "../database.mjs";

function prefixedSettings(prefix) {
  const connectionUrl = process.env[`${prefix}_DATABASE_URL`];
  if (connectionUrl) return databaseSettings({ DATABASE_URL: connectionUrl });
  return databaseSettings({
    DB_TYPE: process.env[`${prefix}_DB_TYPE`],
    DB_HOST: process.env[`${prefix}_DB_HOST`],
    DB_PORT: process.env[`${prefix}_DB_PORT`],
    DB_USER: process.env[`${prefix}_DB_USER`],
    DB_PASSWORD: process.env[`${prefix}_DB_PASSWORD`],
    DB_NAME: process.env[`${prefix}_DB_NAME`]
  });
}

const targetSettings = prefixedSettings("TARGET");
const sourceApiUrl = process.env.SOURCE_API_URL?.replace(/\/$/, "");
const sourceSettings = sourceApiUrl ? null : prefixedSettings("SOURCE");
if (sourceSettings?.connectionUrl && sourceSettings.connectionUrl === targetSettings.connectionUrl) throw new Error("La source et la cible doivent être différentes.");

const source = sourceSettings ? await createDatabase({ settings: sourceSettings, ensureDatabase: false }) : null;
const target = await createDatabase({ settings: targetSettings, ensureDatabase: false });

try {
  if (source) await source.initializeSchema();
  if (process.env.MIGRATION_RESET_TARGET === "true") await target.resetSchema();
  await target.initializeSchema();
  const existingClasses = await target.countClasses();
  if (existingClasses && process.env.MIGRATION_REPLACE_EXISTING !== "true") {
    throw new Error(`La base cible contient déjà ${existingClasses} classe(s). Définissez MIGRATION_REPLACE_EXISTING=true pour autoriser leur remplacement.`);
  }
  const classes = source
    ? await source.readClasses()
    : await fetch(`${sourceApiUrl}/api/classes`).then(async response => {
      if (!response.ok) throw new Error(`API source indisponible (${response.status}).`);
      const payload = await response.json();
      return payload.classes;
    });
  if (!classes.length) throw new Error("La base source ne contient aucune classe à migrer.");
  await target.replaceClasses(classes);
  const studentCount = classes.reduce((total, item) => total + item.students.length, 0);
  const sessionCount = classes.reduce((total, item) => total + item.sessions.length, 0);
  console.log(`Migration terminée : ${classes.length} classes, ${studentCount} élèves et ${sessionCount} séances (${source.kind} → ${target.kind}).`);
} finally {
  await Promise.allSettled([source?.close(), target.close()]);
}
