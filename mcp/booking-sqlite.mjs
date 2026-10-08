// Test helper: node:sqlite's DatabaseSync shaped like a Durable Object's `ctx.storage.sql`, so the
// booking store runs the same SQL in tests as in the Worker. exec(query, ...bindings) returns a
// cursor with toArray() and one(); rows are plain objects.
//
// node:sqlite still prints an ExperimentalWarning on Node 24. That one warning is dropped (others
// pass through) before the module is loaded, so test output stays readable.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && String(warning?.message ?? warning).includes("SQLite")) return;
  return emitWarning.call(this, warning, ...rest);
};
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export function openSql() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings).map((r) => ({ ...r }));
      return {
        toArray: () => rows,
        one() {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
}
