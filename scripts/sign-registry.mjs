import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const signRegistryBytes = (bytes, pem) => {
  const key = createPrivateKey(pem);
  const signature = sign(null, bytes, key);
  if (signature.byteLength !== 64) throw new Error("Ed25519 signature was not 64 bytes.");
  return signature.toString("base64");
};

const readArgs = (argv) => {
  const options = { file: "dist/community-registry.json", keyFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--key") options.keyFile = argv[++index] ?? "";
    else if (!arg.startsWith("--")) options.file = arg;
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
};

if (import.meta.main) {
  const options = readArgs(process.argv.slice(2));
  const pem = options.keyFile
    ? readFileSync(options.keyFile, "utf8")
    : process.env.EDGE_EVER_COMMUNITY_REGISTRY_SIGNING_KEY;
  if (!pem?.includes("PRIVATE")) {
    console.error("Set EDGE_EVER_COMMUNITY_REGISTRY_SIGNING_KEY or pass --key. The private key is not stored in this repository.");
    process.exit(2);
  }
  const bytes = readFileSync(options.file);
  const signature = signRegistryBytes(bytes, pem);
  writeFileSync(`${options.file}.sig`, `${signature}\n`);
  console.log(`Signed ${options.file}.`);
}
