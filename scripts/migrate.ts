// Applies migrations/*.sql in order, once each, inside a transaction per file.
// Refuses to continue if an already-applied migration file was edited (checksum mismatch).
// Usage: DATABASE_URL=postgres://... node scripts/migrate.ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export const LOCAL_DATABASE_URL = "postgres://lap:lap@localhost:54329/lap";

type Sql = ReturnType<typeof postgres>;

export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql`
    create table if not exists schema_migrations (
      version    text        primary key,
      checksum   text        not null,
      applied_at timestamptz not null default now()
    )`;
  const applied = new Map<string, string>(
    (await sql`select version, checksum from schema_migrations`).map((r) => [r.version as string, r.checksum as string]),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const known = applied.get(file);
    if (known) {
      if (known !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version, checksum) values (${file}, ${checksum})`;
    });
    newlyApplied.push(file);
    log(`applied ${file}`);
  }
  return newlyApplied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sql = postgres(process.env.DATABASE_URL ?? LOCAL_DATABASE_URL, { onnotice: () => {} });
  try {
    const done = await migrate(sql, console.log);
    console.log(done.length ? `${done.length} migration(s) applied` : "database is up to date");
  } finally {
    await sql.end();
  }
}
