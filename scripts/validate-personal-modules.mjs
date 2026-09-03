#!/usr/bin/env node
import { runPersonalModulesCli } from "./personal-modules-lib.mjs";
try {
  await runPersonalModulesCli("validate");
} catch (error) {
  console.error(`PERSONAL_MODULES_VALIDATE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
