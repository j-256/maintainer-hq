import example from "../../../../fixtures/import-metadata.json";

export function GET() {
  return new Response(JSON.stringify(example, null, 2) + "\n", {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
