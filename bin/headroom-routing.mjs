#!/usr/bin/env node
import { run } from "../src/cli.mjs";

try {
  const { stdout, stderr, code } = run(process.argv.slice(2));
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`headroom-routing: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
}
