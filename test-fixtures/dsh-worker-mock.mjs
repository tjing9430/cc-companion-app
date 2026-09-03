process.stdin.setEncoding('utf8');
process.stdout.write(`${JSON.stringify({ type: 'ready', model: 'mock-dsh' })}\n`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const cut = buffer.indexOf('\n');
    if (cut < 0) break;
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    const request = JSON.parse(line);
    process.stdout.write(`${JSON.stringify({ type: 'delta', id: request.id, channel: 'thinking', delta: '想一下' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'delta', id: request.id, channel: 'content', delta: 'DSH 流式' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'result', id: request.id, content: 'DSH 流式完成', thinking: '想一下', tools: [], usage: {}, provider: 'dsh', events: [] })}\n`);
  }
});
