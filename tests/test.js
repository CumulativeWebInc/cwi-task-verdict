'use strict';
/* CWI Task Verdict — real tests, zero dependencies. Run: node --test tests/test.js
 * URL checks run against a REAL local HTTP server (not mocks); file checks run
 * against a REAL temp directory; the CLI is spawned as a REAL subprocess. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const TV = require('../verdict.js');

const ROOT = path.join(__dirname, '..');

/* ---------- local HTTP server: real responses, no mocks ---------- */
let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>task verdict ok cwi.task-verdict/1.0</html>'); }
    else if (req.url === '/missing') { res.writeHead(404); res.end('nope'); }
    else if (req.url === '/hang') { /* never responds: exercises the fetch timeout */ }
    else { res.writeHead(500); res.end('boom'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  server.keepAliveTimeout = 50; // don't let idle keep-alive sockets pin the event loop
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
});

/* ---------- temp dir for file checks ---------- */
let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-test-'));
  fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello task verdict world\nsecond line\n');
  fs.writeFileSync(path.join(tmp, 'data.json'), JSON.stringify({ a: { b: 42 }, name: 'x' }));
});
test.afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function M(checks, over = {}) {
  return Object.assign({
    schema: 'cwi.task-verdict/1.0', task_id: 'tv_test_1', title: 't', checks
  }, over);
}
async function run(checks, ioBase) {
  const io = TV.nodeIO(ioBase || tmp);
  return TV.runChecks(M(checks), io);
}

/* ================= manifest parsing ================= */
test('parse: valid manifest passes through', () => {
  const m = TV.parseManifest(M([{ id: 'a', type: 'file_exists', path: 'hello.txt' }]));
  assert.equal(m.task_id, 'tv_test_1');
});
test('parse: invalid JSON rejected', () => {
  assert.throws(() => TV.parseManifest('{nope'), /not valid JSON/);
});
test('parse: wrong schema rejected', () => {
  assert.throws(() => TV.parseManifest(JSON.stringify(M([], { schema: 'cwi.nope/9.9' }))), /schema must be/);
});
test('parse: missing task_id rejected', () => {
  const m = M([{ id: 'a', type: 'file_exists', path: 'x' }]); delete m.task_id;
  assert.throws(() => TV.parseManifest(m), /task_id/);
});
test('parse: empty checks rejected', () => {
  assert.throws(() => TV.parseManifest(M([])), /non-empty array/);
});
test('parse: duplicate check ids rejected', () => {
  assert.throws(() => TV.parseManifest(M([
    { id: 'a', type: 'file_exists', path: 'x' },
    { id: 'a', type: 'file_exists', path: 'y' }
  ])), /duplicate check id/);
});
test('parse: unknown check type rejected', () => {
  assert.throws(() => TV.parseManifest(M([{ id: 'a', type: 'telepathy' }])), /unknown type/);
});
test('parse: invalid regex rejected', () => {
  assert.throws(() => TV.parseManifest(M([{ id: 'a', type: 'file_regex', path: 'x', pattern: '([' }])), /not a valid regex/);
});
test('parse: count_match without min rejected', () => {
  assert.throws(() => TV.parseManifest(M([{ id: 'a', type: 'count_match', path: 'x', pattern: 'y' }])), /"min"/);
});
test('parse: json_field without equals rejected', () => {
  assert.throws(() => TV.parseManifest(M([{ id: 'a', type: 'json_field', path: 'x', field: 'a' }])), /"equals"/);
});

/* ================= engine primitives ================= */
test('canonical: key order does not affect output', () => {
  assert.equal(TV.canonical({ z: 1, a: { d: 4, c: 3 } }), TV.canonical({ a: { c: 3, d: 4 }, z: 1 }));
});
test('deepEqual: nested objects compare by value', () => {
  assert.ok(TV.deepEqual({ a: [1, 2] }, { a: [1, 2] }));
  assert.ok(!TV.deepEqual({ a: 1 }, { a: 2 }));
});
test('getField: walks dotted paths, reports missing', () => {
  assert.deepEqual(TV.getField({ a: { b: 7 } }, 'a.b'), { found: true, value: 7 });
  assert.deepEqual(TV.getField({ a: {} }, 'a.zzz'), { found: false });
});
test('newId: tv_ prefix, 26 chars, unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => TV.newId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^tv_[0-9A-Z]{26}$/);
});
test('computeVerdict: all PASS -> PASS', () => {
  assert.equal(TV.computeVerdict([{ status: 'PASS' }, { status: 'PASS' }]), 'PASS');
});
test('computeVerdict: any FAIL -> FAIL (even with ERRORs)', () => {
  assert.equal(TV.computeVerdict([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'ERROR' }]), 'FAIL');
});
test('computeVerdict: ERRORs but no FAIL -> PARTIAL', () => {
  assert.equal(TV.computeVerdict([{ status: 'PASS' }, { status: 'ERROR' }]), 'PARTIAL');
});
test('computeVerdict: empty results -> ERROR', () => {
  assert.equal(TV.computeVerdict([]), 'ERROR');
});

/* ================= url checks (real server) ================= */
test('url_status: 200 == expect 200 -> PASS, evidence carries HTTP code', async () => {
  const [r] = await run([{ id: 'u1', type: 'url_status', url: base + '/ok' }]);
  assert.equal(r.status, 'PASS');
  assert.equal(r.observed, 200);
  assert.match(r.evidence, /HTTP 200/);
});
test('url_status: 404 vs expect 200 -> FAIL', async () => {
  const [r] = await run([{ id: 'u2', type: 'url_status', url: base + '/missing' }]);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.observed, 404);
});
test('url_status: custom expect honored (404 expected, 404 got -> PASS)', async () => {
  const [r] = await run([{ id: 'u3', type: 'url_status', url: base + '/missing', expect: 404 }]);
  assert.equal(r.status, 'PASS');
});
test('url_contains: pattern present -> PASS', async () => {
  const [r] = await run([{ id: 'u4', type: 'url_contains', url: base + '/ok', pattern: 'cwi\\.task-verdict' }]);
  assert.equal(r.status, 'PASS');
});
test('url_contains: pattern absent -> FAIL', async () => {
  const [r] = await run([{ id: 'u5', type: 'url_contains', url: base + '/ok', pattern: 'definitely-not-here-zzz' }]);
  assert.equal(r.status, 'FAIL');
});
test('url_status: unreachable host -> ERROR (never PASS, never FAIL)', async () => {
  const [r] = await run([{ id: 'u6', type: 'url_status', url: 'http://127.0.0.1:1/nope', timeout_ms: 3000 }]);
  assert.equal(r.status, 'ERROR');
  assert.ok(r.error, 'error message present');
});
test('url_status: hung server hits timeout_ms -> ERROR, not a hang', async () => {
  const t0 = Date.now();
  const [r] = await run([{ id: 'u7', type: 'url_status', url: base + '/hang', timeout_ms: 400 }]);
  assert.equal(r.status, 'ERROR');
  assert.ok(Date.now() - t0 < 8000, 'aborted promptly, took ' + (Date.now() - t0) + 'ms');
});

/* ================= file checks (real temp dir) ================= */
test('file_exists: present -> PASS, absent -> FAIL', async () => {
  const [a, b] = await run([
    { id: 'f1', type: 'file_exists', path: 'hello.txt' },
    { id: 'f2', type: 'file_exists', path: 'ghost.txt' }
  ]);
  assert.equal(a.status, 'PASS');
  assert.equal(b.status, 'FAIL');
});
test('file_regex: match -> PASS, no match -> FAIL', async () => {
  const [a, b] = await run([
    { id: 'f3', type: 'file_regex', path: 'hello.txt', pattern: 'verdict world' },
    { id: 'f4', type: 'file_regex', path: 'hello.txt', pattern: '^nope$' }
  ]);
  assert.equal(a.status, 'PASS');
  assert.equal(b.status, 'FAIL');
});
test('json_field: nested equals -> PASS; wrong value / missing field -> FAIL', async () => {
  const [a, b, c] = await run([
    { id: 'j1', type: 'json_field', path: 'data.json', field: 'a.b', equals: 42 },
    { id: 'j2', type: 'json_field', path: 'data.json', field: 'a.b', equals: 43 },
    { id: 'j3', type: 'json_field', path: 'data.json', field: 'a.zzz', equals: 1 }
  ]);
  assert.equal(a.status, 'PASS');
  assert.equal(b.status, 'FAIL');
  assert.equal(c.status, 'FAIL');
});
test('count_match: threshold met -> PASS, unmet -> FAIL', async () => {
  const [a, b] = await run([
    { id: 'c1', type: 'count_match', path: 'hello.txt', pattern: 'l', min: 3 },
    { id: 'c2', type: 'count_match', path: 'hello.txt', pattern: 'l', min: 99 }
  ]);
  assert.equal(a.status, 'PASS');
  assert.equal(b.status, 'FAIL');
  assert.match(a.observed, /\d+ matches/);
});
test('file_sha256: correct hash -> PASS, wrong hash -> FAIL', async () => {
  const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, 'hello.txt'))).digest('hex');
  const [a, b] = await run([
    { id: 's1', type: 'file_sha256', path: 'hello.txt', sha256: real },
    { id: 's2', type: 'file_sha256', path: 'hello.txt', sha256: '0'.repeat(64) }
  ]);
  assert.equal(a.status, 'PASS');
  assert.equal(b.status, 'FAIL');
});
test('runOne: label propagates from check to result', async () => {
  const [r] = await run([{ id: 'l1', type: 'file_exists', path: 'hello.txt', label: 'engine present' }]);
  assert.equal(r.label, 'engine present');
  const [r2] = await run([{ id: 'l2', type: 'file_exists', path: 'hello.txt' }]);
  assert.equal(r2.label, null);
});
test('file checks: path traversal outside base -> ERROR, not a read', async () => {
  const [r] = await run([{ id: 'x1', type: 'file_exists', path: '../../etc/passwd' }]);
  assert.equal(r.status, 'ERROR');
  assert.match(r.error, /escapes base directory/);
});

/* ================= verdict records ================= */
test('buildRecord: schema, ids, summary, canonical stability', async () => {
  const manifest = M([{ id: 'a', type: 'file_exists', path: 'hello.txt' }], { task_id: 'tv_rec_1', claimed_by: 'tester' });
  manifest._started_at = '2026-09-16T16:00:00.000Z';
  const results = await TV.runChecks(manifest, TV.nodeIO(tmp));
  const rec = TV.buildRecord(manifest, results);
  assert.equal(rec.schema, 'cwi.task-verdict-record/1.0');
  assert.match(rec.record_id, /^tv_[0-9A-Z]{26}$/);
  assert.equal(rec.task_id, 'tv_rec_1');
  assert.equal(rec.verdict, 'PASS');
  assert.deepEqual(rec.summary, { pass: 1, fail: 0, error: 0, total: 1 });
  assert.equal(TV.canonical(JSON.parse(JSON.stringify(rec))), TV.canonical(rec));
});

/* ================= CLI as a real subprocess =================
 * The CLI's URL checks run against a fixture server in its OWN process
 * (tests/fixtures/server.js): a sync-spawned child fetching from the test
 * runner's in-process server would deadlock, because the runner's event
 * loop is blocked inside spawnSync and can never accept() the connection.
 * File checks use the real temp dir. */
const { spawnSync, spawn } = require('node:child_process');

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'server.js')],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture server did not print a port')); }, 10000);
    child.stdout.on('data', d => {
      buf += d.toString();
      const m = buf.match(/\d+/);
      if (m) { clearTimeout(timer); resolve({ child, port: parseInt(m[0], 10) }); }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function writeManifest(dir, obj) {
  const mp = path.join(dir, 'm.json');
  fs.writeFileSync(mp, JSON.stringify(obj));
  return mp;
}

test('CLI: passing manifest (url + file checks) -> exit 0, record written and parseable', async () => {
  const { child, port } = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cli-'));
  try {
    const mp = writeManifest(dir, M([
      { id: 'a', type: 'url_status', url: 'http://127.0.0.1:' + port + '/ok' },
      { id: 'b', type: 'file_exists', path: 'hello.txt' }
    ]));
    const out = path.join(dir, 'verdict.json');
    const p = spawnSync(process.execPath,
      [path.join(ROOT, 'cli', 'verify.js'), mp, '--base', tmp, '--out', out], { encoding: 'utf8' });
    assert.equal(p.status, 0, 'stdout: ' + p.stdout + ' stderr: ' + p.stderr);
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(rec.schema, 'cwi.task-verdict-record/1.0');
    assert.equal(rec.verdict, 'PASS');
    assert.equal(rec.summary.total, 2);
    assert.match(p.stdout, /verdict: PASS/);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI: failing manifest -> exit 2', async () => {
  const { child, port } = await startFixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cli-'));
  try {
    const mp = writeManifest(dir, M([
      { id: 'a', type: 'url_status', url: 'http://127.0.0.1:' + port + '/missing' }
    ]));
    const p = spawnSync(process.execPath,
      [path.join(ROOT, 'cli', 'verify.js'), mp, '--base', tmp], { encoding: 'utf8' });
    assert.equal(p.status, 2, 'stdout: ' + p.stdout + ' stderr: ' + p.stderr);
    assert.match(p.stdout, /verdict: FAIL/);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI: missing manifest file -> exit 1', () => {
  const p = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'verify.js'), '/no/such/file.json'], { encoding: 'utf8' });
  assert.equal(p.status, 1);
});
test('CLI: malformed manifest -> exit 1 with message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cli-'));
  const mp = path.join(dir, 'bad.json');
  fs.writeFileSync(mp, '{"schema":"cwi.task-verdict/1.0"}');
  try {
    const p = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'verify.js'), mp], { encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /invalid manifest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('CLI: import guard — requiring the module runs nothing', () => {
  const before = process.exitCode;
  require('../cli/verify.js');
  assert.equal(process.exitCode, before, 'importing cli/verify.js must not touch exitCode');
});

/* ================= browser adapter honesty ================= */
test('browserIO: file checks refuse honestly instead of faking', async () => {
  const io = TV.browserIO();
  const [r] = await TV.runChecks(M([{ id: 'b1', type: 'file_exists', path: 'x' }]), io);
  assert.equal(r.status, 'ERROR');
  assert.match(r.error, /browser build cannot read local files/);
});
