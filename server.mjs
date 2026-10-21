import "dotenv/config";
import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase, databaseSettings } from "./database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const authUser = process.env.APP_USERNAME || "";
const authPassword = process.env.APP_PASSWORD || "";
const authEnabled = Boolean(authUser && authPassword);
if (process.env.NODE_ENV === "production" && !authEnabled) {
  throw new Error("APP_USERNAME et APP_PASSWORD sont obligatoires en production.");
}
const database = await createDatabase({ settings: databaseSettings() });
await database.initializeSchema();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (_req, res, next) => {
  try {
    await database.health();
    res.json({ status: "ok", database: "connected", engine: database.kind });
  } catch (error) { next(error); }
});

function sameSecret(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

app.use((req, res, next) => {
  if (!authEnabled) return next();
  const [scheme, encoded] = String(req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, ...passwordParts] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (sameSecret(user, authUser) && sameSecret(passwordParts.join(":"), authPassword)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Classia", charset="UTF-8"');
  return res.status(401).send("Authentification requise.");
});

app.get("/api/classes", async (_req, res, next) => {
  try {
    const classes = await database.readClasses();
    res.json({ classes, empty: classes.length === 0, engine: database.kind });
  } catch (error) { next(error); }
});

app.put("/api/classes", async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.classes)) return res.status(400).json({ error: "Le champ classes doit être un tableau." });
    await database.replaceClasses(req.body.classes);
    res.json({ status: "saved", classes: req.body.classes.length, engine: database.kind });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(__dirname, "dist")));
app.use((error, _req, res, _next) => {
  console.error(`[API] ${error.message}`);
  res.status(500).json({ error: "La base de données est momentanément indisponible." });
});

app.listen(port, host, () => console.log(`Classia (${database.kind}) disponible sur http://${host}:${port}`));

async function shutdown() {
  await database.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
