#!/usr/bin/env node
'use strict';
/* CWI Task Verdict — cli/verify.js
 * Run: node cli/verify.js <manifest.json> [--base <dir>] [--out <verdict.json>]
 * Exit codes: 0 = PASS, 2 = FAIL, 3 = PARTIAL (could not fully verify), 1 = usage/manifest error.
 */
const fs = require('node:fs');
const path = require('node:path');
const TV = require('../verdict.js');

function usage() {
  console.error('usage: node cli/verify.js <manifest.json> [--base <dir>] [--out <verdict.json>]');
  console.error('  --base  directory file checks are sandboxed to (default: manifest dir)');
  console.error('  --out   write the machine-readable verdict record JSON to this file');
  console.error('exit codes: 0 PASS · 2 FAIL · 3 PARTIAL · 1 usage/manifest error');
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) { usage(); process.exitCode = 1; return; }
  const manifestPath = args[0];
  let base = path.dirname(path.resolve(manifestPath));
  let out = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) base = path.resolve(args[++i]);
    else if (args[i] === '--out' && args[i + 1]) out = path.resolve(args[++i]);
    else { console.error('unknown argument: ' + args[i]); usage(); process.exitCode = 1; return; }
  }
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch (e) { console.error('cannot read manifest: ' + e.message); process.exitCode = 1; return; }
  let manifest;
  try { manifest = TV.parseManifest(raw); }
  catch (e) { console.error('invalid manifest: ' + e.message); process.exitCode = 1; return; }
  manifest._started_at = new Date().toISOString();
  const io = TV.nodeIO(base);
  const results = await TV.runChecks(manifest, io);
  const record = TV.buildRecord(manifest, results);
  delete record._started_at;

  console.log('task   : ' + record.task_id + (record.title ? ' — ' + record.title : ''));
  console.log('verdict: ' + record.verdict + '  (pass ' + record.summary.pass + ' / fail ' + record.summary.fail + ' / error ' + record.summary.error + ' / total ' + record.summary.total + ')');
  for (const r of record.checks) {
    const mark = r.status === 'PASS' ? '✓' : (r.status === 'FAIL' ? '✗' : '?');
    console.log('  [' + mark + '] ' + r.id + ' (' + r.type + '): ' + r.status +
      (r.observed ? ' — observed: ' + r.observed : '') + (r.error ? ' — ' + r.error : ''));
  }
  if (out) {
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    console.log('record : ' + out);
  }
  process.exitCode = record.verdict === 'PASS' ? 0 : (record.verdict === 'FAIL' ? 2 : 3);
}

// Entry-point guard (CJS): importing this module (tests, tooling) must not run main().
if (require.main === module) {
  main(process.argv).catch(e => { console.error('fatal: ' + (e && e.message)); process.exitCode = 1; });
}
