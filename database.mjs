import pg from "pg";
import mysql from "mysql2/promise";

const { Client, Pool } = pg;

function protocolOf(connectionUrl) {
  const protocol = new URL(connectionUrl).protocol.replace(":", "").toLowerCase();
  if (["postgres", "postgresql"].includes(protocol)) return "postgres";
  if (["mysql", "mariadb"].includes(protocol)) return "mysql";
  throw new Error(`Protocole de base de données non pris en charge : ${protocol || "inconnu"}`);
}

export function databaseSettings(env = process.env) {
  if (env.DATABASE_URL) return { connectionUrl: env.DATABASE_URL, kind: protocolOf(env.DATABASE_URL) };
  const kind = String(env.DB_TYPE || "").toLowerCase();
  if (["mysql", "mariadb"].includes(kind) && env.DB_HOST && env.DB_USER && env.DB_NAME) {
    return { kind: "mysql", mysqlConfig: { host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD || "", database: env.DB_NAME } };
  }
  throw new Error("Configuration de base manquante. Définissez DATABASE_URL, ou DB_TYPE=mysql avec DB_HOST, DB_USER et DB_NAME.");
}

function postgresConfig(connectionUrl, databaseName) {
  const url = new URL(connectionUrl);
  if (databaseName) url.pathname = `/${databaseName}`;
  url.searchParams.delete("serverVersion");
  url.searchParams.delete("charset");
  return { connectionString: url.toString() };
}

async function ensurePostgresDatabase(connectionUrl) {
  const url = new URL(connectionUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error("Nom de base PostgreSQL invalide.");
  const admin = new Client(postgresConfig(connectionUrl, "postgres"));
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (!existing.rowCount) await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally { await admin.end(); }
}

function mysqlConfig(settings) {
  const source = settings.connectionUrl ? new URL(settings.connectionUrl) : null;
  return {
    host: source?.hostname || settings.mysqlConfig?.host,
    port: Number(source?.port || settings.mysqlConfig?.port || 3306),
    user: source ? decodeURIComponent(source.username) : settings.mysqlConfig?.user,
    password: source ? decodeURIComponent(source.password) : settings.mysqlConfig?.password,
    database: source ? decodeURIComponent(source.pathname.slice(1)) : settings.mysqlConfig?.database,
    waitForConnections: true, connectionLimit: 10, charset: "utf8mb4", dateStrings: true, decimalNumbers: true, timezone: "Z"
  };
}

function mysqlStatement(text, params) {
  const ordered = [];
  const sql = text.replace(/\$(\d+)/g, (_match, index) => { ordered.push(params[Number(index) - 1]); return "?"; });
  return { sql, params: ordered };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value); }
  catch { return fallback; }
}

function isoTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).includes("T") ? String(value) : `${String(value).replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

const mysqlTimestamp = value => isoTimestamp(value).replace("T", " ").replace("Z", "");
const numericOrEmpty = value => value === null || value === undefined ? "" : Number(value);
const nullableNumber = value => value === "" || value === null || value === undefined ? null : Number(value);

export async function createDatabase(options = {}) {
  const settings = options.connectionUrl ? { connectionUrl: options.connectionUrl, kind: protocolOf(options.connectionUrl) } : options.settings || databaseSettings(options.env);
  const kind = settings.kind;
  if (kind === "postgres" && options.ensureDatabase !== false) await ensurePostgresDatabase(settings.connectionUrl);
  const pool = kind === "postgres" ? new Pool(postgresConfig(settings.connectionUrl)) : mysql.createPool(mysqlConfig(settings));

  async function query(text, params = [], client = pool) {
    if (kind === "postgres") return client.query(text, params);
    const statement = mysqlStatement(text, params);
    const [result] = await client.query(statement.sql, statement.params);
    return { rows: Array.isArray(result) ? result : [], rowCount: Array.isArray(result) ? result.length : result.affectedRows || 0 };
  }

  async function initializeSchema() {
    if (kind === "postgres") {
      await query(`
        CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', level TEXT NOT NULL DEFAULT '', school_year TEXT NOT NULL DEFAULT '', grade_formula JSONB NOT NULL DEFAULT '{"weights":{}}'::jsonb);
        CREATE TABLE IF NOT EXISTS students (class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, massar TEXT NOT NULL DEFAULT '', birth_date TEXT NOT NULL DEFAULT '', activity_score NUMERIC(5,2), participation_score NUMERIC(5,2), bonus_points INTEGER NOT NULL DEFAULT 0, order_number INTEGER, PRIMARY KEY (class_id, id));
        CREATE TABLE IF NOT EXISTS continuous_columns (class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('activity', 'participation')), enabled BOOLEAN NOT NULL DEFAULT TRUE, name TEXT NOT NULL, PRIMARY KEY (class_id, kind));
        CREATE TABLE IF NOT EXISTS controls (id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, name TEXT NOT NULL, control_date DATE NOT NULL);
        CREATE TABLE IF NOT EXISTS grades (class_id TEXT NOT NULL, student_id TEXT NOT NULL, control_id TEXT NOT NULL REFERENCES controls(id) ON DELETE CASCADE, value NUMERIC(5,2) NOT NULL, PRIMARY KEY (class_id, student_id, control_id), FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, session_date DATE NOT NULL, topic TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated')));
        CREATE TABLE IF NOT EXISTS attendance (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, class_id TEXT NOT NULL, student_id TEXT NOT NULL, h1 TEXT, h2 TEXT, PRIMARY KEY (session_id, student_id), FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, class_id TEXT NOT NULL, student_id TEXT, student_ids TEXT[] NOT NULL DEFAULT '{}', note TEXT NOT NULL DEFAULT '', review_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')), FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE);
        ALTER TABLE classes ADD COLUMN IF NOT EXISTS grade_formula JSONB NOT NULL DEFAULT '{"weights":{}}'::jsonb;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS order_number INTEGER;
        ALTER TABLE observations ADD COLUMN IF NOT EXISTS student_ids TEXT[] NOT NULL DEFAULT '{}';
        ALTER TABLE observations ALTER COLUMN student_id DROP NOT NULL;
        UPDATE observations SET student_ids = ARRAY[student_id] WHERE cardinality(student_ids) = 0 AND student_id IS NOT NULL;
      `);
      return;
    }
    const statements = [
      `CREATE TABLE IF NOT EXISTS classes (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL, subject VARCHAR(255) NOT NULL DEFAULT '', level VARCHAR(255) NOT NULL DEFAULT '', school_year VARCHAR(16) NOT NULL DEFAULT '', grade_formula JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS students (class_id VARCHAR(64) NOT NULL, id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL, massar VARCHAR(64) NOT NULL DEFAULT '', birth_date VARCHAR(10) NOT NULL DEFAULT '', activity_score DECIMAL(5,2) NULL, participation_score DECIMAL(5,2) NULL, bonus_points INT NOT NULL DEFAULT 0, order_number INT NULL, PRIMARY KEY (class_id, id), CONSTRAINT students_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS continuous_columns (class_id VARCHAR(64) NOT NULL, kind VARCHAR(32) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, name VARCHAR(255) NOT NULL, PRIMARY KEY (class_id, kind), CONSTRAINT continuous_columns_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS controls (id VARCHAR(64) PRIMARY KEY, class_id VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL, control_date DATE NOT NULL, CONSTRAINT controls_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS grades (class_id VARCHAR(64) NOT NULL, student_id VARCHAR(64) NOT NULL, control_id VARCHAR(64) NOT NULL, value DECIMAL(5,2) NOT NULL, PRIMARY KEY (class_id, student_id, control_id), CONSTRAINT grades_student_fk FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE, CONSTRAINT grades_control_fk FOREIGN KEY (control_id) REFERENCES controls(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS sessions (id VARCHAR(64) PRIMARY KEY, class_id VARCHAR(64) NOT NULL, session_date DATE NOT NULL, topic VARCHAR(500) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'draft', CONSTRAINT sessions_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS attendance (session_id VARCHAR(64) NOT NULL, class_id VARCHAR(64) NOT NULL, student_id VARCHAR(64) NOT NULL, h1 VARCHAR(16) NULL, h2 VARCHAR(16) NULL, PRIMARY KEY (session_id, student_id), CONSTRAINT attendance_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE, CONSTRAINT attendance_student_fk FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS observations (id VARCHAR(64) PRIMARY KEY, class_id VARCHAR(64) NOT NULL, student_id VARCHAR(64) NULL, student_ids JSON NOT NULL, note TEXT NOT NULL, review_date DATE NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), status VARCHAR(16) NOT NULL DEFAULT 'open', CONSTRAINT observations_student_fk FOREIGN KEY (class_id, student_id) REFERENCES students(class_id, id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ];
    for (const statement of statements) await query(statement);
  }

  async function resetSchema() {
    const tables = ["attendance", "observations", "grades", "sessions", "controls", "continuous_columns", "students", "classes"];
    if (kind === "postgres") {
      await query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
      return;
    }
    await query("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const table of tables) await query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally {
      await query("SET FOREIGN_KEY_CHECKS = 1");
    }
  }

  async function readClasses() {
    const dateColumn = column => kind === "postgres" ? `${column}::text` : column;
    const results = await Promise.all([
      query("SELECT * FROM classes ORDER BY id"), query("SELECT * FROM students ORDER BY class_id, id"),
      query("SELECT * FROM continuous_columns ORDER BY class_id, kind"), query(`SELECT id, class_id, name, ${dateColumn("control_date")} AS date FROM controls ORDER BY class_id, control_date, id`),
      query("SELECT * FROM grades ORDER BY class_id, student_id, control_id"), query(`SELECT id, class_id, ${dateColumn("session_date")} AS date, topic, status FROM sessions ORDER BY class_id, session_date, id`),
      query("SELECT * FROM attendance ORDER BY class_id, session_id, student_id"), query(`SELECT id, class_id, student_id, student_ids, note, ${dateColumn("review_date")} AS review_date, created_at, status FROM observations ORDER BY class_id, created_at, id`)
    ]);
    const [classRows, studentRows, columnRows, controlRows, gradeRows, sessionRows, attendanceRows, observationRows] = results;
    const classes = classRows.rows.map(row => ({ id: row.id, name: row.name, subject: row.subject, level: row.level, year: row.school_year, gradeFormula: parseJson(row.grade_formula, { weights: {} }), controls: [], sessions: [], observations: [], students: [], continuousColumns: { activity: { enabled: true, name: "Activités" }, participation: { enabled: true, name: "Participation" } } }));
    const byClass = new Map(classes.map(item => [item.id, item]));
    const students = new Map();
    for (const row of studentRows.rows) {
      const student = { id: row.id, name: row.name, massar: row.massar, birthDate: row.birth_date, grades: {}, activityScore: numericOrEmpty(row.activity_score), participationScore: numericOrEmpty(row.participation_score), bonusPoints: Number(row.bonus_points), orderNumber: row.order_number === null ? null : Number(row.order_number) };
      byClass.get(row.class_id)?.students.push(student); students.set(`${row.class_id}\u0000${row.id}`, student);
    }
    for (const row of columnRows.rows) { const target = byClass.get(row.class_id); if (target) target.continuousColumns[row.kind] = { enabled: Boolean(row.enabled), name: row.name }; }
    for (const row of controlRows.rows) byClass.get(row.class_id)?.controls.push({ id: row.id, name: row.name, date: row.date });
    for (const row of gradeRows.rows) { const student = students.get(`${row.class_id}\u0000${row.student_id}`); if (student) student.grades[row.control_id] = Number(row.value); }
    const sessions = new Map();
    for (const row of sessionRows.rows) { const session = { id: row.id, date: row.date, topic: row.topic, status: row.status, attendance: {} }; byClass.get(row.class_id)?.sessions.push(session); sessions.set(row.id, session); }
    for (const row of attendanceRows.rows) { const status = {}; if (row.h1) status.h1 = row.h1; if (row.h2) status.h2 = row.h2; const session = sessions.get(row.session_id); if (session) session.attendance[row.student_id] = status; }
    for (const row of observationRows.rows) byClass.get(row.class_id)?.observations.push({ id: row.id, studentId: row.student_id, studentIds: parseJson(row.student_ids, row.student_id ? [row.student_id] : []), note: row.note, reviewDate: row.review_date || "", createdAt: isoTimestamp(row.created_at), status: row.status });
    return classes;
  }

  async function replaceClasses(classes) {
    const client = kind === "postgres" ? await pool.connect() : await pool.getConnection();
    try {
      if (kind === "postgres") await client.query("BEGIN"); else await client.beginTransaction();
      await query("DELETE FROM observations", [], client); await query("DELETE FROM classes", [], client);
      for (const classItem of classes) {
        await query("INSERT INTO classes (id, name, subject, level, school_year, grade_formula) VALUES ($1,$2,$3,$4,$5,$6)", [classItem.id, classItem.name, classItem.subject || "", classItem.level || "", classItem.year || "", kind === "mysql" ? JSON.stringify(classItem.gradeFormula || { weights: {} }) : classItem.gradeFormula || { weights: {} }], client);
        const columns = classItem.continuousColumns || {};
        for (const [columnKind, fallback] of [["activity", "Activités"], ["participation", "Participation"]]) { const column = columns[columnKind] || { enabled: true, name: fallback }; await query("INSERT INTO continuous_columns (class_id, kind, enabled, name) VALUES ($1,$2,$3,$4)", [classItem.id, columnKind, column.enabled !== false, column.name || fallback], client); }
        for (const student of classItem.students || []) await query("INSERT INTO students (class_id,id,name,massar,birth_date,activity_score,participation_score,bonus_points,order_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [classItem.id, student.id, student.name, student.massar || "", student.birthDate || "", nullableNumber(student.activityScore), nullableNumber(student.participationScore), Number(student.bonusPoints) || 0, nullableNumber(student.orderNumber)], client);
        for (const control of classItem.controls || []) await query("INSERT INTO controls (id,class_id,name,control_date) VALUES ($1,$2,$3,$4)", [control.id, classItem.id, control.name, control.date], client);
        for (const student of classItem.students || []) for (const [controlId, value] of Object.entries(student.grades || {})) if (value !== "" && value !== null && value !== undefined) await query("INSERT INTO grades (class_id,student_id,control_id,value) VALUES ($1,$2,$3,$4)", [classItem.id, student.id, controlId, Number(value)], client);
        for (const session of classItem.sessions || []) { await query("INSERT INTO sessions (id,class_id,session_date,topic,status) VALUES ($1,$2,$3,$4,$5)", [session.id, classItem.id, session.date, session.topic || "", session.status === "validated" ? "validated" : "draft"], client); for (const [studentId, attendance] of Object.entries(session.attendance || {})) await query("INSERT INTO attendance (session_id,class_id,student_id,h1,h2) VALUES ($1,$2,$3,$4,$5)", [session.id, classItem.id, studentId, attendance.h1 || null, attendance.h2 || null], client); }
        for (const observation of classItem.observations || []) { const studentIds = Array.isArray(observation.studentIds) ? observation.studentIds : (observation.studentId ? [observation.studentId] : []); await query("INSERT INTO observations (id,class_id,student_id,student_ids,note,review_date,created_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [observation.id, classItem.id, studentIds[0] || null, kind === "mysql" ? JSON.stringify(studentIds) : studentIds, observation.note || "", observation.reviewDate || null, kind === "mysql" ? mysqlTimestamp(observation.createdAt) : observation.createdAt || new Date().toISOString(), observation.status === "done" ? "done" : "open"], client); }
      }
      if (kind === "postgres") await client.query("COMMIT"); else await client.commit();
    } catch (error) {
      if (kind === "postgres") await client.query("ROLLBACK"); else await client.rollback();
      throw error;
    } finally { client.release(); }
  }

  async function countClasses() { const result = await query("SELECT COUNT(*) AS total FROM classes"); return Number(result.rows[0]?.total || 0); }

  return { kind, initializeSchema, resetSchema, readClasses, replaceClasses, countClasses, health: () => query("SELECT 1"), close: () => pool.end() };
}
