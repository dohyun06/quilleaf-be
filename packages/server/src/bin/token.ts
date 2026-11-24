import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readServerConfig } from "../config";
import { openDatabase } from "../db";
import { runPairCommand } from "../pairCommand";
import { PairStore } from "../pairStore";
import { runTokenCommand } from "../tokenCommand";
import { TokenStore } from "../tokenStore";

const config = readServerConfig(process.env);
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
const write = (line: string): void => void process.stdout.write(`${line}\n`);
try {
  const args = process.argv.slice(2);
  const tokens = new TokenStore(db);
  process.exitCode = args[0] === "pair" ? runPairCommand(args, new PairStore(db, tokens), write) : runTokenCommand(args, tokens, write);
} finally {
  db.close();
}