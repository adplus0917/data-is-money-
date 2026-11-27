// Postgres pool for the vault workers and the data room (the web app uses server/db.js).
const { Pool } = require("pg");
let pool;
module.exports = function pg() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const ssl = process.env.PGSSL === "false" || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
  pool = new Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL || 5), connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, keepAlive: true });
  pool.on("error", (e) => console.error("pg pool idle client error:", e.message));
  return pool;
};
