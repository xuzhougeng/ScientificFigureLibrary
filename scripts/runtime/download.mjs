import path from 'node:path';
import { installRuntime } from './runtime-lib.mjs';
const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/runtime/download.mjs win-x64|darwin-arm64|darwin-x64');
console.log(JSON.stringify(await installRuntime(target, path.resolve('.runtime-cache', 'extracted', target)), null, 2));
