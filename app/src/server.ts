import http from 'http';
import os from 'os';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'local';
const APP_VERSION = process.env.APP_VERSION ?? 'dev';

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, extra?: object): void {
  process.stdout.write(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      environment: ENVIRONMENT,
      version: APP_VERSION,
      hostname: os.hostname(),
      ...extra,
    }) + '\n',
  );
}

const server = http.createServer((req, res) => {
  const start = Date.now();

  if (req.url === '/health') {
    const body = JSON.stringify({ status: 'healthy', uptime: Math.floor(process.uptime()) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  const body = JSON.stringify({
    message: 'Hello from Deswik Platform!',
    version: APP_VERSION,
    environment: ENVIRONMENT,
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);

  log('INFO', 'Request handled', {
    method: req.method,
    url: req.url,
    statusCode: 200,
    durationMs: Date.now() - start,
  });
});

server.listen(PORT, () => {
  log('INFO', 'Server started', { port: PORT });
});

// Graceful shutdown: ECS sends SIGTERM 30 s before SIGKILL during task replacement
process.on('SIGTERM', () => {
  log('INFO', 'SIGTERM received — draining connections');
  server.close(() => {
    log('INFO', 'All connections closed, exiting cleanly');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  log('ERROR', 'Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
