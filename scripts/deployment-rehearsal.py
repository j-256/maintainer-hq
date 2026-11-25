#!/usr/bin/env python3
"""Validate a private D1 export and project exact SQLite values for local restoration"""
import json
import sqlite3
import sys


def identifier(name):
    return '"' + name.replace('"', '""') + '"'


def projection(column):
    name = identifier(column)
    return ("CASE typeof(" + name + ") WHEN 'text' THEN 'text:' || hex(CAST(" + name + " AS BLOB)) "
            "WHEN 'blob' THEN 'blob:' || hex(" + name + ") "
            "WHEN 'real' THEN 'real:' || printf('%!.26g', " + name + ") "
            "ELSE typeof(" + name + ") || ':' || quote(" + name + ") END")


def snapshot(path):
    with open(path, encoding="utf-8") as source:
        sql = source.read()
    with sqlite3.connect(":memory:") as database:
        database.executescript(sql)
        if database.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("Export integrity check failed")
        if database.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Export foreign key check failed")
        tables = database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY name").fetchall()
        result = []
        for (name,) in tables:
            columns = [row[1] for row in database.execute("PRAGMA table_info(" + identifier(name) + ")")]
            values = ",".join(projection(column) for column in columns)
            rows = database.execute("SELECT " + values + " FROM " + identifier(name)).fetchall()
            result.append({"name": name, "columns": columns, "rows": rows})
        return result


if __name__ == "__main__":
    try:
        print(json.dumps(snapshot(sys.argv[1])))
    except Exception:
        print("Private export validation failed", file=sys.stderr)
        sys.exit(1)
