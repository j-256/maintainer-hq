import { createServer } from "node:http";
import { build } from "vite";
import { SECURITY_HEADERS } from "../shared/security";

export async function createCryptoVerificationServer() {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: {
        entry: "e2e/secret-crypto-fixture.ts",
        formats: ["es"],
        fileName: "probe",
      },
      minify: true,
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if (!bundle || !("output" in bundle))
    throw new Error("Expected a verification bundle");
  const outputs = new Map(
    bundle.output.map((asset) => [
      asset.fileName,
      asset.type === "chunk" ? asset.code : asset.source,
    ]),
  );
  const entry = bundle.output.find(
    (asset) => asset.type === "chunk" && asset.isEntry,
  );
  if (!entry) throw new Error("Verification entry unavailable");
  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      response.setHeader(name, value);
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><head><title>HQ client encryption check</title></head><body><main><h1>Client encryption verification</h1><output>Checking...</output></main><script type="module" src="/' +
          entry.fileName +
          '"></script></body></html>',
      );
    } else if (outputs.has(request.url!.slice(1))) {
      response.setHeader("Content-Type", "application/javascript");
      response.end(outputs.get(request.url!.slice(1)));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Verification listener unavailable");
  return { server, url: "http://127.0.0.1:" + address.port };
}
