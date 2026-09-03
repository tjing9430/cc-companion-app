// SSE 推送:客户端集合、事件广播、流式握手。
// 快照的拼装需要跨全域数据,由 server.js 在启动时注入,避免反向依赖。
const sseClients = new Set();

let snapshotProvider = () => ({});
function setSnapshotProvider(fn) { snapshotProvider = fn; }
function streamSnapshot(scope) { return snapshotProvider(scope); }

function handleSseStream(req, res, scope = 'all') {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const client = { res, scope };
  sseClients.add(client);
  writeSse(client, 'ready', { scope, now: new Date().toISOString() });
  writeSse(client, 'snapshot', streamSnapshot(scope));
  const keepAlive = setInterval(() => {
    writeSse(client, 'ping', { now: new Date().toISOString() });
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
}

function streamScopeForRoute(route) {
  if (route === '/api/group/stream') return 'group';
  if (route === '/api/chat/stream') return 'chat';
  return 'all';
}

function broadcastSse(event, payload) {
  if (!sseClients.size) return;
  for (const client of Array.from(sseClients)) {
    if (!shouldSendToClient(client, event, payload)) continue;
    writeSse(client, event, payload);
  }
}

function shouldSendToClient(client, event, payload) {
  if (!client || client.scope === 'all') return true;
  // Scoped streams accept every present/future event that explicitly names
  // their scope. This avoids silently dropping new event types such as
  // message-stream while still keeping global console/settings traffic out.
  if (payload && payload.scope) return payload.scope === client.scope;
  return false;
}

function writeSse(client, event, payload) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    sseClients.delete(client);
  }
}

export {
  sseClients, handleSseStream, streamScopeForRoute, streamSnapshot,
  broadcastSse, writeSse, setSnapshotProvider, shouldSendToClient,
};
