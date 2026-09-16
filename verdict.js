/* CWI Task Verdict — verdict.js v1.0.0
 * Zero-dependency UMD engine: turn any delegated task's claims into checkable
 * receipts. A task manifest (cwi.task-verdict/1.0) lists evidence-bound checks;
 * the runner executes them and emits a machine-readable verdict record
 * (cwi.task-verdict-record/1.0) with PASS / FAIL / PARTIAL.
 *
 * Node path runs every check (URLs via fetch, files via fs, sandboxed to a
 * base directory). Browser path runs URL checks only — file checks return
 * ERROR with an honest message telling the user to run the CLI instead.
 *
 * Honest limits: a PASS proves the listed checks passed at run time — not that
 * the task was "good". An ERROR means "could not verify", never "passed".
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], function () { return factory('browser'); });
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory('node');
  } else {
    root.TaskVerdict = factory('browser');
  }
}(typeof self !== 'undefined' ? self : this, function (ENV) {

'use strict';

var VERSION = '1.0.0';
var SCHEMA_MANIFEST = 'cwi.task-verdict/1.0';
var SCHEMA_RECORD = 'cwi.task-verdict-record/1.0';
var ID_PREFIX = 'tv_';
var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/* ---------------- canonical JSON (sorted keys, no whitespace) ---------------- */

function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonical(v[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(v);
}

/* ---------------- ids ---------------- */

function randomBytes16() {
  if (typeof require === 'function') return require('node:crypto').randomBytes(16);
  var bytes = new Uint8Array(16);
  var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
  if (c) c.getRandomValues(bytes);
  else { var i; for (i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256); }
  return bytes;
}

function newId() {
  var t = Date.now(), i;
  var rb = randomBytes16(); // 16 x 5-bit groups = 80 bits
  var id = ID_PREFIX;
  var n = t;
  var timeChars = '';
  for (i = 0; i < 10; i++) { timeChars = CROCKFORD[n % 32] + timeChars; n = Math.floor(n / 32); }
  id += timeChars;
  for (i = 0; i < 16; i++) id += CROCKFORD[rb[i] & 31];
  return id;
}

/* ---------------- manifest parsing ---------------- */

var CHECK_TYPES = ['url_status', 'url_contains', 'file_exists', 'file_sha256',
  'file_regex', 'json_field', 'count_match'];

function manifestError(msg) { var e = new Error('manifest: ' + msg); e.code = 'MANIFEST'; return e; }

function parseManifest(input) {
  var m;
  if (typeof input === 'string') {
    try { m = JSON.parse(input); }
    catch (e) { throw manifestError('not valid JSON: ' + e.message); }
  } else if (input && typeof input === 'object') {
    m = input;
  } else {
    throw manifestError('expected a JSON string or object');
  }
  if (m.schema !== SCHEMA_MANIFEST)
    throw manifestError('schema must be "' + SCHEMA_MANIFEST + '" (got ' + JSON.stringify(m.schema) + ')');
  if (typeof m.task_id !== 'string' || !m.task_id)
    throw manifestError('task_id must be a non-empty string');
  if (!Array.isArray(m.checks) || m.checks.length === 0)
    throw manifestError('checks must be a non-empty array');
  if (m.timeout_ms !== undefined && (typeof m.timeout_ms !== 'number' || m.timeout_ms <= 0))
    throw manifestError('"timeout_ms" must be a positive number');
  var ids = {};
  m.checks.forEach(function (c, i) {
    if (!c || typeof c !== 'object') throw manifestError('checks[' + i + '] must be an object');
    if (typeof c.id !== 'string' || !c.id) throw manifestError('checks[' + i + '].id must be a non-empty string');
    if (ids[c.id]) throw manifestError('duplicate check id "' + c.id + '"');
    ids[c.id] = true;
    if (CHECK_TYPES.indexOf(c.type) === -1)
      throw manifestError('checks[' + i + '] has unknown type "' + c.type + '" (known: ' + CHECK_TYPES.join(', ') + ')');
    validateCheckParams(c, i);
  });
  return m;
}

function validateCheckParams(c, i) {
  var at = 'checks[' + i + '] (' + c.id + ')';
  function need(field, kind) {
    if (typeof c[field] !== kind || (kind === 'string' && !c[field]))
      throw manifestError(at + ': "' + field + '" must be a non-empty ' + kind);
  }
  if (c.type === 'url_status' || c.type === 'url_contains') need('url', 'string');
  if (c.type === 'url_status' && c.expect !== undefined && typeof c.expect !== 'number')
    throw manifestError(at + ': "expect" must be a number');
  if (c.type === 'url_contains') need('pattern', 'string');
  if (c.type === 'file_exists' || c.type === 'file_sha256' || c.type === 'file_regex' ||
      c.type === 'json_field' || c.type === 'count_match') need('path', 'string');
  if (c.type === 'file_sha256') need('sha256', 'string');
  if (c.type === 'file_regex' || c.type === 'count_match') need('pattern', 'string');
  if (c.type === 'count_match' && (typeof c.min !== 'number' || c.min < 0))
    throw manifestError(at + ': "min" must be a non-negative number');
  if (c.type === 'json_field') { need('field', 'string'); if (!('equals' in c)) throw manifestError(at + ': "equals" is required'); }
  if (c.timeout_ms !== undefined && (typeof c.timeout_ms !== 'number' || c.timeout_ms <= 0))
    throw manifestError(at + ': "timeout_ms" must be a positive number');
  ['pattern'].forEach(function (f) {
    if (typeof c[f] === 'string') { try { new RegExp(c[f]); } catch (e) { throw manifestError(at + ': "' + f + '" is not a valid regex: ' + e.message); } }
  });
}

/* ---------------- io adapters ---------------- */

function nodeIO(baseDir) {
  var fs = require('node:fs');
  var path = require('node:path');
  var crypto = require('node:crypto');
  var base = path.resolve(baseDir || process.cwd());
  function safeJoin(p) {
    var resolved = path.resolve(base, p);
    if (resolved !== base && resolved.indexOf(base + path.sep) !== 0)
      throw new Error('path escapes base directory: ' + p);
    return resolved;
  }
  return {
    env: 'node',
    fetchText: async function (url, timeoutMs) {
      var res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs || 15000) });
      var text = await res.text();
      return { status: res.status, url: res.url, text: text };
    },
    readFile: function (p) { return fs.readFileSync(safeJoin(p), 'utf8'); },
    fileExists: function (p) {
      var full = safeJoin(p); // throws on traversal: must surface as ERROR, never as a quiet "missing"
      try { fs.accessSync(full); return true; } catch (e) { return false; }
    },
    sha256: function (p) { return crypto.createHash('sha256').update(fs.readFileSync(safeJoin(p))).digest('hex'); }
  };
}

function browserIO() {
  return {
    env: 'browser',
    fetchText: async function (url, timeoutMs) {
      var res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs || 15000) });
      var text = await res.text();
      return { status: res.status, url: res.url, text: text };
    },
    readFile: function () { throw new Error('browser build cannot read local files — run the CLI (node cli/verify.js) for file checks'); },
    fileExists: function () { throw new Error('browser build cannot read local files — run the CLI (node cli/verify.js) for file checks'); },
    sha256: function () { throw new Error('browser build cannot read local files — run the CLI (node cli/verify.js) for file checks'); }
  };
}

/* ---------------- check runners ---------------- */

function deepEqual(a, b) { return canonical(a) === canonical(b); }

function getField(obj, dotted) {
  var parts = String(dotted).split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== 'object' || !(parts[i] in cur)) return { found: false };
    cur = cur[parts[i]];
  }
  return { found: true, value: cur };
}

async function runOne(check, io, defaultTimeoutMs) {
  var r = { id: check.id, type: check.type, label: check.label || null, status: 'ERROR', evidence: null, error: null };
  var timeoutMs = check.timeout_ms || defaultTimeoutMs || 15000;
  try {
    if (check.type === 'url_status') {
      r.target = check.url;
      r.expected = check.expect === undefined ? 200 : check.expect;
      var f = await io.fetchText(check.url, timeoutMs);
      r.observed = f.status;
      r.evidence = 'HTTP ' + f.status + ' <- ' + f.url;
      r.status = (f.status === r.expected) ? 'PASS' : 'FAIL';
    } else if (check.type === 'url_contains') {
      r.target = check.url;
      r.expected = 'body matches /' + check.pattern + '/';
      var g = await io.fetchText(check.url, timeoutMs);
      var hit = new RegExp(check.pattern).test(g.text);
      r.observed = hit ? 'pattern found' : 'pattern not found';
      r.evidence = 'HTTP ' + g.status + ', ' + g.text.length + ' bytes fetched from ' + g.url;
      r.status = (g.status >= 200 && g.status < 300 && hit) ? 'PASS' : 'FAIL';
    } else if (check.type === 'file_exists') {
      r.target = check.path;
      r.expected = 'file exists';
      var ex = io.fileExists(check.path);
      r.observed = ex ? 'exists' : 'missing';
      r.evidence = ex ? check.path + ' readable' : check.path + ' not found under base dir';
      r.status = ex ? 'PASS' : 'FAIL';
    } else if (check.type === 'file_sha256') {
      r.target = check.path;
      r.expected = 'sha256=' + check.sha256;
      var h = io.sha256(check.path);
      r.observed = 'sha256=' + h;
      r.evidence = 'computed sha256 of ' + check.path;
      r.status = (h.toLowerCase() === String(check.sha256).toLowerCase()) ? 'PASS' : 'FAIL';
    } else if (check.type === 'file_regex') {
      r.target = check.path;
      r.expected = 'content matches /' + check.pattern + '/';
      var body = io.readFile(check.path);
      var ok = new RegExp(check.pattern).test(body);
      r.observed = ok ? 'pattern found' : 'pattern not found';
      r.evidence = check.path + ' (' + body.length + ' chars read)';
      r.status = ok ? 'PASS' : 'FAIL';
    } else if (check.type === 'json_field') {
      r.target = check.path + '#' + check.field;
      r.expected = 'field ' + check.field + ' equals ' + canonical(check.equals);
      var raw = io.readFile(check.path);
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { r.error = 'file is not valid JSON: ' + e.message; r.status = 'FAIL'; return r; }
      var gf = getField(obj, check.field);
      r.observed = gf.found ? canonical(gf.value) : 'field missing';
      r.evidence = check.path + ' parsed (' + raw.length + ' chars)';
      r.status = (gf.found && deepEqual(gf.value, check.equals)) ? 'PASS' : 'FAIL';
    } else if (check.type === 'count_match') {
      r.target = check.path;
      r.expected = 'at least ' + check.min + ' matches of /' + check.pattern + '/';
      var txt = io.readFile(check.path);
      var matches = txt.match(new RegExp(check.pattern, 'g')) || [];
      r.observed = matches.length + ' matches';
      r.evidence = check.path + ' (' + txt.length + ' chars read)';
      r.status = (matches.length >= check.min) ? 'PASS' : 'FAIL';
    }
  } catch (e) {
    r.status = 'ERROR';
    r.error = e.message;
    r.evidence = r.evidence || null;
  }
  return r;
}

async function runChecks(manifest, io) {
  var defaultTimeoutMs = (manifest && manifest.timeout_ms) || 15000;
  var results = [];
  for (var i = 0; i < manifest.checks.length; i++) {
    results.push(await runOne(manifest.checks[i], io, defaultTimeoutMs));
  }
  return results;
}

/* ---------------- verdict ---------------- */

function summarize(results) {
  var s = { pass: 0, fail: 0, error: 0, total: results.length };
  results.forEach(function (r) {
    if (r.status === 'PASS') s.pass++;
    else if (r.status === 'FAIL') s.fail++;
    else s.error++;
  });
  return s;
}

function computeVerdict(results) {
  if (results.length === 0) return 'ERROR';
  var s = summarize(results);
  if (s.fail > 0) return 'FAIL';
  if (s.error > 0) return 'PARTIAL';
  return 'PASS';
}

function buildRecord(manifest, results) {
  var now = new Date().toISOString();
  var started = manifest._started_at || now;
  return {
    schema: SCHEMA_RECORD,
    record_id: newId(),
    task_id: manifest.task_id,
    title: manifest.title || null,
    claimed_by: manifest.claimed_by || null,
    verdict: computeVerdict(results),
    engine: 'task-verdict/' + VERSION,
    started_at: started,
    finished_at: now,
    summary: summarize(results),
    checks: results
  };
}

return {
  VERSION: VERSION,
  SCHEMA_MANIFEST: SCHEMA_MANIFEST,
  SCHEMA_RECORD: SCHEMA_RECORD,
  canonical: canonical,
  newId: newId,
  parseManifest: parseManifest,
  validateCheckParams: validateCheckParams,
  nodeIO: (ENV === 'node') ? nodeIO : undefined,
  browserIO: browserIO,
  runChecks: runChecks,
  runOne: runOne,
  summarize: summarize,
  computeVerdict: computeVerdict,
  buildRecord: buildRecord,
  getField: getField,
  deepEqual: deepEqual
};

}));
