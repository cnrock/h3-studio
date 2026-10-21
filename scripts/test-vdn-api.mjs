import http from 'node:http';
import assert from 'node:assert/strict';

const jobs = new Map();
const server = http.createServer((req, res) => {
  const send = (code, value, type = 'application/json') => {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    res.writeHead(code, { 'content-type': type, 'content-length': body.length });
    res.end(body);
  };
  if (req.method === 'POST' && req.url === '/v1/videos') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const id = 'vdn-test-job';
      jobs.set(id, { count: 0, body });
      send(200, { id, object: 'video', status: 'queued', progress: 0, file_path: '/tmp/test.mp4' });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/videos/vdn-test-job') {
    const job = jobs.get('vdn-test-job');
    job.count++;
    send(200, job.count < 2 ? { id: 'vdn-test-job', status: 'running', progress: 50 } : { id: 'vdn-test-job', status: 'completed', url: null });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/videos/vdn-test-job/content') {
    send(200, Buffer.from('fake-mp4'), 'video/mp4'); return;
  }
  send(404, { error: 'not found' });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.H3_API_MODE = 'vdn';
process.env.H3_BASE_URL = `http://127.0.0.1:${port}`;
process.env.H3_MODEL = 'vdn-minimax-h3';
process.env.H3_POLL_MS = '1';
process.env.H3_POLL_TIMEOUT_MS = '5000';
const { generateVideo } = await import('../server/h3.js?test=' + Date.now());
const result = await generateVideo({ prompt: 'test', mode: 't2va', width: 1344, height: 768, aspectRatio: '16:9', duration: 5, steps: 50, flowShift: 12, audioFlowShift: 3, files: [] });
assert.equal(result.contentType, 'video/mp4');
assert.equal(result.bytes.toString(), 'fake-mp4');
assert.equal(jobs.get('vdn-test-job').count, 2);
console.log('VDN async submit -> poll -> content: OK');
server.close();
