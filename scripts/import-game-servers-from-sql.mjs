import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const DEFAULT_SQL_PATH = "C:/Users/PC/Desktop/Linh tinh/SKT7/game_servers.sql";
const DEFAULT_GAME_NAME = "Ninja Mobile";
const NINJA_2D_GAME_NAME = "Ninja 2D";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  loadDotEnvFile(path.resolve(process.cwd(), ".env"));
  loadDotEnvFile(path.resolve(process.cwd(), "backend/.env"));

  const sqlPath = path.resolve(process.argv[2] || process.env.GAME_SERVERS_SQL_PATH || DEFAULT_SQL_PATH);
  const sql = await readFile(sqlPath, "utf8");
  const rows = parseGameServerRows(sql).map(normalizeGameServerRow);
  if (rows.length === 0) throw new Error(`No game_servers rows found in ${sqlPath}`);

  const config = await readMysqlConfig();
  await ensureDatabase(config);

  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
  });

  try {
    await ensureGameServersTable(conn);

    let imported = 0;
    for (const row of rows) {
      await upsertGameServer(conn, row);
      imported++;
    }

    await migrateLegacyGameServerGameNames(conn);
    console.log(`Imported ${imported} game_servers rows into database '${config.database}'.`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

function parseGameServerRows(sql) {
  const rows = [];
  const insertRe = /INSERT\s+INTO\s+`?game_servers`?(?:\s*\(([^)]*)\))?\s+VALUES\s*(.+?);/gis;
  let match;
  while ((match = insertRe.exec(sql))) {
    const columns = match[1]
      ? match[1].split(",").map((column) => column.replace(/[`"' ]/g, "").trim()).filter(Boolean)
      : null;
    for (const tuple of splitTuples(match[2])) {
      const values = splitValues(tuple).map(parseSqlValue);
      rows.push(valuesToRow(values, columns));
    }
  }
  return rows;
}

function splitTuples(body) {
  const tuples = [];
  let current = "";
  let depth = 0;
  let quote = false;
  let escaped = false;

  for (const char of body) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'") {
        quote = false;
      }
      continue;
    }

    if (char === "'") {
      quote = true;
      current += char;
      continue;
    }
    if (char === "(") {
      if (depth > 0) current += char;
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) {
        tuples.push(current);
        current = "";
      } else {
        current += char;
      }
      continue;
    }
    if (depth > 0) current += char;
  }

  return tuples;
}

function splitValues(tuple) {
  const values = [];
  let current = "";
  let quote = false;
  let escaped = false;

  for (const char of tuple) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "'") {
        quote = false;
      }
      continue;
    }

    if (char === "'") {
      quote = true;
      current += char;
      continue;
    }
    if (char === ",") {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function parseSqlValue(value) {
  if (/^null$/i.test(value)) return null;
  if (value.startsWith("'") && value.endsWith("'")) {
    return value
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/''/g, "'")
      .replace(/\\\\/g, "\\");
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : value;
}

function valuesToRow(values, columns) {
  if (columns && columns.length === values.length) {
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  }

  if (values.length >= 21) {
    return {
      id: values[0],
      game_name: values[1],
      name: values[2],
      code: values[3],
      status: values[4],
      db_host: values[5],
      db_port: values[6],
      db_user: values[7],
      db_password: values[8],
      db_game_database: values[9],
      db_player_database: values[10],
      socket_host: values[11],
      socket_port: values[12],
      socket_key: values[13],
      socket_port_web: values[14],
      socket_key_web: values[15],
      is_default: values[16],
      display_order: values[17],
      created_at: values[18],
      updated_at: values[19],
      day_open: values[20],
    };
  }

  return {
    id: values[0],
    name: values[1],
    code: values[2],
    status: values[3],
    db_host: values[4],
    db_port: values[5],
    db_user: values[6],
    db_password: values[7],
    db_game_database: values[8],
    db_player_database: values[9],
    socket_host: values[10],
    socket_port: values[11],
    socket_key: values[12],
    socket_port_web: values[13],
    socket_key_web: values[14],
    is_default: values[15],
    display_order: values[16],
    created_at: values[17],
    updated_at: values[18],
    day_open: values[19],
  };
}

function normalizeGameServerRow(row) {
  return {
    gameName: normalizeGameName(row.game_name || inferGameName(row)),
    name: stringValue(row.name),
    code: stringValue(row.code || row.name),
    status: normalizeStatus(row.status),
    dbHost: stringValue(row.db_host),
    dbPort: numberValue(row.db_port, 3306),
    dbUser: stringValue(row.db_user),
    dbPassword: stringValue(row.db_password),
    dbGameDatabase: stringValue(row.db_game_database),
    dbPlayerDatabase: stringValue(row.db_player_database),
    socketHost: stringValue(row.socket_host),
    socketPort: numberValue(row.socket_port, 5900),
    socketKey: stringValue(row.socket_key),
    socketPortWeb: stringValue(row.socket_port_web),
    socketKeyWeb: stringValue(row.socket_key_web),
    isDefault: numberValue(row.is_default, 0) ? 1 : 0,
    displayOrder: numberValue(row.display_order, 0),
    createdAt: stringValue(row.created_at) || new Date().toISOString(),
    updatedAt: stringValue(row.updated_at) || new Date().toISOString(),
    dayOpen: stringValue(row.day_open) || null,
  };
}

function inferGameName(row) {
  const text = [
    row.name,
    row.code,
    row.db_user,
    row.db_game_database,
    row.db_player_database,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return text.includes("2d") ? NINJA_2D_GAME_NAME : DEFAULT_GAME_NAME;
}

async function upsertGameServer(conn, row) {
  await conn.execute(
    `INSERT INTO game_servers (
      game_name, name, code, status, db_host, db_port, db_user, db_password,
      db_game_database, db_player_database, socket_host, socket_port, socket_key,
      socket_port_web, socket_key_web, is_default, display_order, created_at, updated_at, day_open
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      status = VALUES(status),
      db_host = VALUES(db_host),
      db_port = VALUES(db_port),
      db_user = VALUES(db_user),
      db_password = VALUES(db_password),
      db_game_database = VALUES(db_game_database),
      db_player_database = VALUES(db_player_database),
      socket_host = VALUES(socket_host),
      socket_port = VALUES(socket_port),
      socket_key = VALUES(socket_key),
      socket_port_web = VALUES(socket_port_web),
      socket_key_web = VALUES(socket_key_web),
      is_default = VALUES(is_default),
      display_order = VALUES(display_order),
      updated_at = VALUES(updated_at),
      day_open = VALUES(day_open)`,
    [
      row.gameName,
      row.name,
      row.code,
      row.status,
      row.dbHost,
      row.dbPort,
      row.dbUser,
      row.dbPassword,
      row.dbGameDatabase,
      row.dbPlayerDatabase,
      row.socketHost,
      row.socketPort,
      row.socketKey,
      row.socketPortWeb || null,
      row.socketKeyWeb || null,
      row.isDefault,
      row.displayOrder,
      row.createdAt,
      row.updatedAt,
      row.dayOpen,
    ],
  );
}

async function ensureDatabase(config) {
  const admin = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: "utf8mb4",
  });
  try {
    await admin.execute(
      `CREATE DATABASE IF NOT EXISTS \`${safeIdentifier(config.database)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function ensureGameServersTable(conn) {
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS game_servers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      game_name VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile',
      name VARCHAR(100) NOT NULL,
      code VARCHAR(50) NOT NULL,
      status VARCHAR(32) NULL DEFAULT 'offline',
      db_host VARCHAR(255) NOT NULL,
      db_port INT NOT NULL DEFAULT 3306,
      db_user VARCHAR(100) NOT NULL,
      db_password VARCHAR(255) NULL,
      db_game_database VARCHAR(100) NOT NULL,
      db_player_database VARCHAR(100) NOT NULL,
      socket_host VARCHAR(255) NOT NULL DEFAULT '',
      socket_port INT NOT NULL DEFAULT 5900,
      socket_key VARCHAR(255) NOT NULL DEFAULT '',
      socket_port_web VARCHAR(255) NULL,
      socket_key_web VARCHAR(255) NULL,
      is_default TINYINT(1) NULL DEFAULT 0,
      display_order INT NULL DEFAULT 0,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      day_open VARCHAR(40) NULL,
      UNIQUE KEY game_servers_game_code_uq (game_name, code),
      KEY game_servers_game_name_idx (game_name, name),
      KEY game_servers_status_idx (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await ensureColumn(conn, "game_servers", "game_name", "VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile' AFTER id");
  await ensureColumn(conn, "game_servers", "socket_port_web", "VARCHAR(255) NULL");
  await ensureColumn(conn, "game_servers", "socket_key_web", "VARCHAR(255) NULL");
  await ensureColumn(conn, "game_servers", "day_open", "VARCHAR(40) NULL");
  await dropIndexIfExists(conn, "game_servers", "code");
  await ensureUniqueIndex(conn, "game_servers", "game_servers_game_code_uq", "game_name, code");
  await ensureIndex(conn, "game_servers", "game_servers_game_name_idx", "game_name, name");
  await ensureIndex(conn, "game_servers", "game_servers_status_idx", "status");
}

async function migrateLegacyGameServerGameNames(conn) {
  await conn.execute(
    `UPDATE game_servers
     SET game_name = ?
     WHERE LOWER(COALESCE(db_user, '')) LIKE '%2d%'
        OR LOWER(COALESCE(db_game_database, '')) LIKE '%2d%'
        OR LOWER(COALESCE(db_player_database, '')) LIKE '%2d%'`,
    [NINJA_2D_GAME_NAME],
  );
  await conn.execute(
    `UPDATE game_servers
     SET game_name = ?
     WHERE game_name IS NULL OR TRIM(game_name) = ''`,
    [DEFAULT_GAME_NAME],
  );
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${safeIdentifier(table)}\` LIKE ?`, [column]);
  if (rows.length > 0) return;
  await conn.execute(`ALTER TABLE \`${safeIdentifier(table)}\` ADD COLUMN \`${safeIdentifier(column)}\` ${definition}`);
}

async function ensureIndex(conn, table, indexName, columns) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${safeIdentifier(table)}\` WHERE Key_name = ?`, [indexName]);
  if (rows.length > 0) return;
  await conn.execute(
    `ALTER TABLE \`${safeIdentifier(table)}\` ADD KEY \`${safeIdentifier(indexName)}\` (${formatIndexColumns(columns)})`,
  );
}

async function ensureUniqueIndex(conn, table, indexName, columns) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${safeIdentifier(table)}\` WHERE Key_name = ?`, [indexName]);
  if (rows.length > 0) return;
  await conn.execute(
    `ALTER TABLE \`${safeIdentifier(table)}\` ADD UNIQUE KEY \`${safeIdentifier(indexName)}\` (${formatIndexColumns(columns)})`,
  );
}

async function dropIndexIfExists(conn, table, indexName) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${safeIdentifier(table)}\` WHERE Key_name = ?`, [indexName]);
  if (rows.length === 0) return;
  await conn.execute(`ALTER TABLE \`${safeIdentifier(table)}\` DROP INDEX \`${safeIdentifier(indexName)}\``);
}

async function readMysqlConfig() {
  const props = await readServerMysqlProperties(process.env.NSO_SERVER_MYSQL_PROPERTIES);
  return {
    host: process.env.BANDO_DB_HOST || props["nsoz.database.main.host"] || "127.0.0.1",
    port: Number(process.env.BANDO_DB_PORT || props["nsoz.database.main.port"] || 3306),
    user: process.env.BANDO_DB_USER || props["nsoz.database.main.user"] || "root",
    password: process.env.BANDO_DB_PASS ?? props["nsoz.database.main.pass"] ?? "",
    database: process.env.BANDO_DB_NAME || "bando",
  };
}

async function readServerMysqlProperties(explicitPath) {
  const result = {};
  const propertiesPath = explicitPath || "C:/Users/PC/Desktop/Code/nso-server/mysql.properties";
  try {
    const raw = await readFile(propertiesPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
  } catch {
  }
  return result;
}

function loadDotEnvFile(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] == null) process.env[key] = value;
    }
  } catch {
  }
}

function normalizeStatus(value) {
  const status = stringValue(value || "offline").toLowerCase();
  return ["online", "offline", "maintenance", "new"].includes(status) ? status : "offline";
}

function normalizeGameName(value) {
  return stringValue(value || DEFAULT_GAME_NAME) || DEFAULT_GAME_NAME;
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function formatIndexColumns(value) {
  return String(value)
    .split(",")
    .map((column) => `\`${safeIdentifier(column.trim())}\``)
    .join(", ");
}

function safeIdentifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe MySQL identifier: ${value}`);
  }
  return value;
}
