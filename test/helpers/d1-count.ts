export function countD1Statements(database: D1Database) {
  let count = 0;
  let calls = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        const value = Reflect.get(target, key, target);
        if (["first", "all", "run", "raw"].includes(String(key)))
          return (...args: unknown[]) => {
            count++;
            calls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  }
  const db = new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          count += statements.length;
          calls++;
          return target.batch(
            statements.map(
              (statement) => originals.get(statement) ?? statement,
            ),
          );
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db,
    count: () => count,
    calls: () => calls,
    reset: () => {
      count = 0;
      calls = 0;
    },
  };
}
