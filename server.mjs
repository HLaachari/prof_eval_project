import "dotenv/config";
import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Client, Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL est manquante. Copiez .env.example vers .env et renseignez PostgreSQL.");
}

function databaseConfig(databaseName) {
  const url = new URL(process.env.DATABASE_URL);
  if (databaseName) url.pathname = `/${databaseName}`;
  url.searchParams.delete("serverVersion");
  url.searchParams.delete("charset");
  return { connectionString: url.toString() };
}

async function ensureDatabaseExists() {
  const url = new URL(process.env.DATABASE_URL);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error("Nom de base PostgreSQL invalide.");
  const admin = new Client(databaseConfig("postgres"));
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (!existing.rowCount) await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

await ensureDatabaseExists();
const pool = new Pool(databaseConfig());

async function initializeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT '',
      school_year TEXT NOT NULL DEFAULT '',
      grade_formula JSONB NOT NULL DEFAULT '{"weights":{}}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS students (
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      massar TEXT NOT NULL DEFAULT '',
      birth_date TEXT NOT NULL DEFAULT '',
      activity_score NUMERIC(5,2),
      participation_score NUMERIC(5,2),
      bonus_points INTEGER NOT NULL DEFAULT 0,
      order_number INTEGER,
      PRIMARY KEY (class_id, id)
    );
    CREATE TABLE IF NOT EXISTS continuous_columns (
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('activity', 'participation')),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      name TEXT NOT NULL,
      PRIMARY KEY (class_id, kind)
    );
    CREATE TABLE IF NOT EXISTS controls (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      control_date DATE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grades (
      class_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      control_id TEXT NOT NULL REFERENCES controls(id) ON DELETE CASCADE,
      value NUMERIC(5,2) NOT NULL,
      PRIMARY KEY (class_id, student_id, control_id),
      FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      session_date DATE NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated'))
    );
    CREATE TABLE IF NOT EXISTS attendance (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      class_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      h1 TEXT,
      h2 TEXT,
      PRIMARY KEY (session_id, student_id),
      FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL,
      student_id TEXT,
      student_ids TEXT[] NOT NULL DEFAULT '{}',
      note TEXT NOT NULL DEFAULT '',
      review_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
      FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE
    );
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS grade_formula JSONB NOT NULL DEFAULT '{"weights":{}}'::jsonb;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS order_number INTEGER;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS student_ids TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE observations ALTER COLUMN student_id DROP NOT NULL;
    UPDATE observations SET student_ids = ARRAY[student_id] WHERE cardinality(student_ids) = 0 AND student_id IS NOT NULL;
  `);
}

await initializeSchema();

const numericOrEmpty = value => value === null || value === undefined ? "" : Number(value);

async function readClasses() {
  const [classRows, studentRows, columnRows, controlRows, gradeRows, sessionRows, attendanceRows, observationRows] = await Promise.all([
    pool.query("SELECT * FROM classes ORDER BY id"),
    pool.query("SELECT * FROM students ORDER BY class_id, id"),
    pool.query("SELECT * FROM continuous_columns ORDER BY class_id, kind"),
    pool.query("SELECT id, class_id, name, control_date::text AS date FROM controls ORDER BY class_id, control_date, id"),
    pool.query("SELECT * FROM grades ORDER BY class_id, student_id, control_id"),
    pool.query("SELECT id, class_id, session_date::text AS date, topic, status FROM sessions ORDER BY class_id, session_date, id"),
    pool.query("SELECT * FROM attendance ORDER BY class_id, session_id, student_id"),
    pool.query("SELECT id, class_id, student_id, student_ids, note, review_date::text AS review_date, created_at, status FROM observations ORDER BY class_id, created_at, id")
  ]);

  const classes = classRows.rows.map(row => ({
    id: row.id, name: row.name, subject: row.subject, level: row.level, year: row.school_year, gradeFormula: row.grade_formula || { weights: {} },
    controls: [], sessions: [], observations: [], students: [],
    continuousColumns: {
      activity: { enabled: true, name: "Activités" },
      participation: { enabled: true, name: "Participation" }
    }
  }));
  const byClass = new Map(classes.map(item => [item.id, item]));
  const students = new Map();

  for (const row of studentRows.rows) {
    const student = {
      id: row.id, name: row.name, massar: row.massar, birthDate: row.birth_date,
      grades: {}, activityScore: numericOrEmpty(row.activity_score),
      participationScore: numericOrEmpty(row.participation_score), bonusPoints: row.bonus_points, orderNumber: row.order_number
    };
    byClass.get(row.class_id)?.students.push(student);
    students.set(`${row.class_id}\u0000${row.id}`, student);
  }
  for (const row of columnRows.rows) {
    const target = byClass.get(row.class_id);
    if (target) target.continuousColumns[row.kind] = { enabled: row.enabled, name: row.name };
  }
  for (const row of controlRows.rows) byClass.get(row.class_id)?.controls.push({ id: row.id, name: row.name, date: row.date });
  for (const row of gradeRows.rows) {
    const student = students.get(`${row.class_id}\u0000${row.student_id}`);
    if (student) student.grades[row.control_id] = Number(row.value);
  }
  const sessions = new Map();
  for (const row of sessionRows.rows) {
    const session = { id: row.id, date: row.date, topic: row.topic, status: row.status, attendance: {} };
    byClass.get(row.class_id)?.sessions.push(session);
    sessions.set(row.id, session);
  }
  for (const row of attendanceRows.rows) {
    const status = {};
    if (row.h1) status.h1 = row.h1;
    if (row.h2) status.h2 = row.h2;
    sessions.get(row.session_id).attendance[row.student_id] = status;
  }
  for (const row of observationRows.rows) {
    byClass.get(row.class_id)?.observations.push({
      id: row.id, studentId: row.student_id, studentIds: row.student_ids || (row.student_id ? [row.student_id] : []), note: row.note,
      reviewDate: row.review_date || "", createdAt: row.created_at.toISOString(), status: row.status
    });
  }
  return classes;
}

const nullableNumber = value => value === "" || value === null || value === undefined ? null : Number(value);

async function replaceClasses(classes) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // General observations have a null student_id, so the composite student FK
    // cannot cascade them when classes are replaced. Clear them explicitly.
    await client.query("DELETE FROM observations");
    await client.query("DELETE FROM classes");
    for (const classItem of classes) {
      await client.query("INSERT INTO classes (id, name, subject, level, school_year, grade_formula) VALUES ($1,$2,$3,$4,$5,$6)", [classItem.id, classItem.name, classItem.subject || "", classItem.level || "", classItem.year || "", classItem.gradeFormula || { weights: {} }]);
      const columns = classItem.continuousColumns || {};
      for (const [kind, fallback] of [["activity", "Activités"], ["participation", "Participation"]]) {
        const column = columns[kind] || { enabled: true, name: fallback };
        await client.query("INSERT INTO continuous_columns (class_id, kind, enabled, name) VALUES ($1,$2,$3,$4)", [classItem.id, kind, column.enabled !== false, column.name || fallback]);
      }
      for (const student of classItem.students || []) {
        await client.query("INSERT INTO students (class_id,id,name,massar,birth_date,activity_score,participation_score,bonus_points,order_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [classItem.id, student.id, student.name, student.massar || "", student.birthDate || "", nullableNumber(student.activityScore), nullableNumber(student.participationScore), Number(student.bonusPoints) || 0, nullableNumber(student.orderNumber)]);
      }
      for (const control of classItem.controls || []) {
        await client.query("INSERT INTO controls (id,class_id,name,control_date) VALUES ($1,$2,$3,$4)", [control.id, classItem.id, control.name, control.date]);
      }
      for (const student of classItem.students || []) {
        for (const [controlId, value] of Object.entries(student.grades || {})) {
          if (value !== "" && value !== null && value !== undefined) await client.query("INSERT INTO grades (class_id,student_id,control_id,value) VALUES ($1,$2,$3,$4)", [classItem.id, student.id, controlId, Number(value)]);
        }
      }
      for (const session of classItem.sessions || []) {
        await client.query("INSERT INTO sessions (id,class_id,session_date,topic,status) VALUES ($1,$2,$3,$4,$5)", [session.id, classItem.id, session.date, session.topic || "", session.status === "validated" ? "validated" : "draft"]);
        for (const [studentId, attendance] of Object.entries(session.attendance || {})) {
          await client.query("INSERT INTO attendance (session_id,class_id,student_id,h1,h2) VALUES ($1,$2,$3,$4,$5)", [session.id, classItem.id, studentId, attendance.h1 || null, attendance.h2 || null]);
        }
      }
      for (const observation of classItem.observations || []) {
        const studentIds = Array.isArray(observation.studentIds) ? observation.studentIds : (observation.studentId ? [observation.studentId] : []);
        await client.query("INSERT INTO observations (id,class_id,student_id,student_ids,note,review_date,created_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [observation.id, classItem.id, studentIds[0] || null, studentIds, observation.note || "", observation.reviewDate || null, observation.createdAt || new Date().toISOString(), observation.status === "done" ? "done" : "open"]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (_req, res, next) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", database: "connected" }); }
  catch (error) { next(error); }
});
app.get("/api/classes", async (_req, res, next) => {
  try { const classes = await readClasses(); res.json({ classes, empty: classes.length === 0 }); }
  catch (error) { next(error); }
});
app.put("/api/classes", async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.classes)) return res.status(400).json({ error: "Le champ classes doit être un tableau." });
    await replaceClasses(req.body.classes);
    res.json({ status: "saved", classes: req.body.classes.length });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(__dirname, "dist")));
app.use((error, _req, res, _next) => {
  console.error(`[API] ${error.message}`);
  res.status(500).json({ error: "La base de données est momentanément indisponible." });
});

app.listen(port, "127.0.0.1", () => console.log(`Classia disponible sur http://localhost:${port}`));

async function shutdown() {
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
