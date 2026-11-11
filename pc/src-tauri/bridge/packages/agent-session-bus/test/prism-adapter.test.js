'use strict'
/**
 * PrismAdapter contract: the DSH wire protocol re-exported under the
 * prism-agent identity with the dedicated prism descriptor path. The mock
 * bridge serves the same frames the prism plugin mints.
 *
 * Mirrors test/dsh-adapter.test.js for the prism identity only; the shared
 * transport edge cases stay covered there.
 */
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { PrismAdapter } = require('../src/adapters/prism')
const { createCapabilityStore } = require('../../../../../../integrations/dsh-hachimodock/capability')

const token = 'a'.repeat(64), epoch = 'b'.repeat(64)

// The real Windows ACL scripts are validated by their own suite; on hosts
// where PowerShell create-directory is unavailable the guard is replaced by
// this stub that records the operation and reproduces the filesystem
// side effects (directory creation, private empty file), so the wire
// contract stays testable.
function recordingAcl(calls) {
  return (operation, target) => {
    calls.push([operation, target])
    if (operation === 'prepare-directory') fs.mkdirSync(target, { recursive: true })
    else if (operation === 'create-file') fs.writeFileSync(target, '', { flag: 'wx' })
  }
}

async function fixture(t, handler) {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    Promise.resolve(handler(req, res)).catch(e => res.destroy(e))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-bus-'))
  const dir = path.join(container, 'private')
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(container, { recursive: true, force: true }) })
  const file = path.join(dir, 'capability.json'), baseUrl = `http://127.0.0.1:${server.address().port}`
  const descriptor = { version: 2, epoch, baseUrl, tokens: { bus: token } }
  const aclCalls = []
  const acl = recordingAcl(aclCalls)
  if (process.platform === 'win32') {
    // The same writer ordering with the guard stubbed at the OS boundary.
    createCapabilityStore({ acl }).writeDescriptor(descriptor, file)
  } else {
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' })
  }
  return { file, baseUrl, aclCalls, adapter: new PrismAdapter({ env: { HACHIMODOCK_PRISM_CAPABILITY_FILE: file }, acl }) }
}

function sse(res, frames) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const [e, d] of frames) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end() }
async function collect(a, request) { const events = []; for await (const e of a.inject(request)) events.push(e); return events }

test('the prism identity and descriptor path are distinct from DSH', () => {
  const adapter = new PrismAdapter({})
  assert.equal(adapter.agentId, 'prism-agent')
  const prismPath = adapter._capabilityFile.replace(/\\/g, '/')
  assert.ok(prismPath.endsWith('.claw-pet/prism-bridge/capability.json'), prismPath)
  const dsh = new (require('../src/adapters/dsh').DshAdapter)({})
  const dshPath = dsh._capabilityFile.replace(/\\/g, '/')
  assert.ok(dshPath.endsWith('.claw-pet/dsh-bridge/capability.json'), dshPath)
  assert.notEqual(prismPath, dshPath)
})

test('availability authenticates the prism descriptor endpoint via sessions', async t => {
  const { adapter } = await fixture(t, (req, res) => { assert.equal(req.url, '/sessions'); res.end(JSON.stringify({ version: 2, sessions: [] })) })
  assert.deepEqual(await adapter.isAvailable(), { ready: true, reason: null, version: 2 })
})

test('a missing descriptor answers not-ready without touching the network', async t => {
  const adapter = new PrismAdapter({ env: { HACHIMODOCK_PRISM_CAPABILITY_FILE: path.join(os.tmpdir(), 'prism-bus-missing', 'capability.json') } })
  const status = await adapter.isAvailable()
  assert.equal(status.ready, false)
  assert.ok(status.reason.includes('Prism'))
})

test('listSessions returns the bridge summaries in modified order', async t => {
  const { adapter } = await fixture(t, (req, res) => {
    res.end(JSON.stringify({ version: 2, sessions: [
      { id: 's-new', title: 'Fix the runtime', cwd: '/tmp/prism', lastModified: 200, status: 'running', agentId: 'prism-agent' },
      { id: 's-old', title: null, cwd: null, lastModified: 100, status: 'idle', agentId: 'prism-agent' },
    ] }))
  })
  const rows = await adapter.listSessions({})
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 's-new')
  assert.equal(rows[1].id, 's-old')
})

test('inject streams the admission receipt and refuses auto targets', async t => {
  const { adapter } = await fixture(t, (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      assert.equal(parsed.sessionId, 's-live')
      sse(res, [['done', { sessionId: 's-live', tokens: 0, stopReason: 'admitted' }]])
    })
  })
  const events = await collect(adapter, { sessionId: 's-live', text: 'hello' })
  assert.deepEqual(events, [{ kind: 'done', sessionId: 's-live', tokens: 0, stopReason: 'admitted' }])
  const refused = await collect(adapter, { sessionId: 'auto', text: 'hello' })
  assert.equal(refused[0].code, 'EXACT_SESSION_REQUIRED')
})
