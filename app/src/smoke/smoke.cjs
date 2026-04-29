'use strict';

// Standalone smoke test:
//   1. spawn the daemon
//   2. connect over the named pipe
//   3. call `status`, then `indicate` (no await), then `shutdown`
// Designed to be run with: node app/src/smoke/smoke.cjs

const { spawnDaemon } = require('../shim/launcher.cjs');
const { IpcClient } = require('../ipc/client.cjs');
const { daemonPipePath } = require('../common/paths.cjs');

const logger = {
  info: (...a) => process.stderr.write(`[smoke] ${a.join(' ')}\n`),
  warn: (...a) => process.stderr.write(`[smoke][warn] ${a.join(' ')}\n`),
  error: (...a) => process.stderr.write(`[smoke][error] ${a.join(' ')}\n`),
};

async function main() {
  logger.info('spawning daemon...');
  const pid = spawnDaemon({ logger });
  logger.info(`daemon spawned pid=${pid}`);

  const client = new IpcClient({ pipePath: daemonPipePath(), logger });
  await client.connect();

  const status = await client.call('status');
  logger.info('status:', JSON.stringify(status));

  const perceive = await client.call('perceive', {});
  logger.info(`perceive: nodes=${Array.isArray(perceive) ? perceive.length : 'N/A'}`);

  const ind = await client.call('indicate', {
    indicator: { type: 'info', title: 'smoke', text: 'pupil-mcp smoke test', append: false, await: false },
  });
  logger.info('indicate:', JSON.stringify(ind));

  await new Promise((r) => setTimeout(r, 1500));

  const shutdownRes = await client.call('shutdown').catch((err) => ({ error: err.message }));
  logger.info('shutdown:', JSON.stringify(shutdownRes));

  client.close();
  logger.info('smoke ok');
  process.exit(0);
}

main().catch((err) => {
  logger.error('smoke failed:', err.stack || err.message);
  process.exit(1);
});
