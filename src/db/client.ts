import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

/** One short-lived client per request/cron invocation; Hyperdrive does the pooling. */
export function createSql(connectionString: string): Sql {
  return postgres(connectionString, {
    max: 5,
    fetch_types: false, // avoids an extra round trip per connection on Workers
    prepare: true,
    onnotice: () => {},
  });
}
