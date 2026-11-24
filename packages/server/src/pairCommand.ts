import type { PairStore } from "./pairStore";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./tokenCommand";
import { InvalidVaultIdError } from "./tokenStore";

export const PAIR_USAGE = "  pair approve <code> <vaultId>   approve a device that is showing a pairing code";

export function runPairCommand(args: readonly string[], pairs: PairStore, write: (line: string) => void): number {
  const [group, action, code, vaultId] = args;
  if (group !== "pair" || action !== "approve" || !code || !vaultId) {
    write(`usage:\n${PAIR_USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const approved = pairs.approve(code, vaultId);
    if (!approved) {
      write("no pending pairing request with that code (unknown, expired or already approved)");
      return EXIT_FAILED;
    }
    // the approve workflow prints this to a public Actions log: no device name or vault ID
    write("approved");
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof InvalidVaultIdError)) throw error;
    write(error.message);
    return EXIT_FAILED;
  }
}