#!/usr/bin/env node
import { startBackend } from "./agent/backend.js";
startBackend().catch(() => {
  console.error(
    "Rider startup failed. Verify backend dependency configuration.",
  );
  process.exitCode = 1;
});
