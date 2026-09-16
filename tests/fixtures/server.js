'use strict';
/* Fixture HTTP server for CLI tests. Runs in its OWN process so the test
 * runner's event loop stays free to accept connections (spawning a sync
 * child that fetches from an in-process server would deadlock).
 * Prints its ephemeral port on stdout, then serves forever. */
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fixture ok'); }
  else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('fixture missing'); }
});
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
});
