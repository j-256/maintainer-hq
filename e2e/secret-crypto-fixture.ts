import sodium from "libsodium-wrappers";
import { sealGitHubSecret } from "../shared/github-secret-crypto";

async function verify() {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const value = new TextEncoder().encode("synthetic-browser-only\r\n\u2603");
  try {
    const sealed = await sealGitHubSecret(
      value,
      sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    );
    const clear = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
    );
    if (
      clear.length !== value.length ||
      !clear.every((byte, index) => byte === value[index])
    )
      throw new Error("Round trip failed");
    let javascriptEvalBlocked = false;
    try {
      new Function("return 1")();
    } catch (error) {
      javascriptEvalBlocked = error instanceof EvalError;
    }
    document.querySelector("output")!.textContent = javascriptEvalBlocked
      ? "PASS: exact bytes restored; JavaScript string evaluation blocked"
      : "FAIL: JavaScript string evaluation allowed";
  } finally {
    sodium.memzero(pair.privateKey);
  }
}

verify().catch(() => {
  document.querySelector("output")!.textContent =
    "FAIL: client encryption unavailable";
});
