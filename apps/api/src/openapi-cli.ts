#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateOpenApi, renderApiMarkdown } from "./openapi.js";

const docs = fileURLToPath(new URL("../../../docs/", import.meta.url));
const doc = await generateOpenApi();
writeFileSync(`${docs}openapi.json`, `${JSON.stringify(doc, null, 2)}\n`);
writeFileSync(`${docs}api.md`, renderApiMarkdown(doc));
process.stdout.write("wrote docs/openapi.json and docs/api.md\n");
