import { expect, test } from "./test-fixture";
import { createCryptoVerificationServer } from "./secret-crypto-server";

test("browser sealing works under production CSP without JavaScript eval", async ({
  page,
}) => {
  const { server, url } = await createCryptoVerificationServer();
  try {
    const response = await page.goto(url);
    expect(response?.headers()["content-security-policy"]).toContain(
      "'wasm-unsafe-eval'",
    );
    await expect(page.locator("output")).toHaveText(
      "PASS: exact bytes restored; JavaScript string evaluation blocked",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
