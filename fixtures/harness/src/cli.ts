#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { startHarness } from "./harness.js";

const basePort = process.env.HARNESS_BASE_PORT ? Number(process.env.HARNESS_BASE_PORT) : undefined;
const host = process.env.HARNESS_HOST ?? "127.0.0.1";
const caOut = process.env.HARNESS_CA_OUT;

const harness = await startHarness({
  host,
  basePort,
  log: (line) => process.stderr.write(`[harness] ${line}\n`),
});

if (caOut) writeFileSync(caOut, harness.caCertPem);
process.stdout.write(`${JSON.stringify(harness.targets, null, 2)}\n`);
process.stderr.write(
  `[harness] serving ${Object.keys(harness.targets.apps).length} fixture apps and ${Object.keys(harness.targets.simulators).length} simulators; control at ${harness.targets.control}__harness/targets\n`,
);

const shutdown = () => {
  harness.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
