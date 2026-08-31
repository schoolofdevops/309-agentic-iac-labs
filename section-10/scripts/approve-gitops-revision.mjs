#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Compatibility guard: approval publication exists only inside the foreground opener.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stderr.write("Approval not written: LIVE_HOLDER_REQUIRED. Use the foreground gate opener.\n");
  process.exitCode = 1;
}
