import {loadLocalEnv} from "./env.ts";
loadLocalEnv();
import { Pool } from "pg";
import { historyPolicy } from "./history-policy.ts";

// Configure optional database-native jobs independently of the application's storage budgets.
const plan = historyPolicy(
  Number(process.env.NOX_HISTORY_COMPRESSION_DAYS ?? 0),
  Number(process.env.NOX_HISTORY_RETENTION_DAYS ?? 0),
);
const apply = process.argv.includes("--apply");
if (!apply)
  console.log(
    JSON.stringify(
      {
        applied: false,
        ...plan,
        notice:
          "Dry run. This command configures database-native jobs only. Application-managed retention and byte budgets operate separately.",
      },
      null,
      2,
    ),
  );
else {
  if (plan.destructive && !process.argv.includes("--confirm-history-deletion"))
    throw new Error(
      "Retention requires --confirm-history-deletion and a reviewed backup/retention decision",
    );
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  const client = await pool.connect();
  try {
    const jobs = await client.query(
      "SELECT job_id,proc_name FROM timescaledb_information.jobs WHERE hypertable_name='nox_history_events' AND proc_name IN ('policy_compression','policy_retention')",
    );
    if (jobs.rowCount)
      throw new Error(
        "Existing lifecycle policy detected. Review it explicitly; this command never replaces policies silently.",
      );
    await client.query("BEGIN");
    try {
      for (const statement of plan.statements)
        await client.query(statement.sql, statement.values);
      await client.query("COMMIT");
      console.log(
        JSON.stringify({
          applied: true,
          compressionDays: plan.compressionDays,
          retentionDays: plan.retentionDays,
        }),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}
