import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: clientRoot,
  configFile: resolve(clientRoot, 'vite.browser-test.config.js'),
  envFile: false,
  mode: 'browser-test',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5194,
    strictPort: true,
  },
});

await server.listen();
server.printUrls();

let closing = false;
async function closeServer() {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once('SIGINT', () => closeServer().then(() => process.exit(0)));
process.once('SIGTERM', () => closeServer().then(() => process.exit(0)));
