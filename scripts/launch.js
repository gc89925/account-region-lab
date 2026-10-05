import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLabServer } from '../server.js';

export async function inspectService(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    const data = await response.json().catch(() => null);
    return response.ok && data?.app === 'account-region-lab' && data?.ready === true ? 'ready' : 'occupied';
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED' ? 'stopped' : 'unavailable';
  }
}

export async function startWorkspace({ port = Number(process.env.PORT || 4317), ...options } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535.');
  const status = await inspectService(port);
  const url = `http://127.0.0.1:${port}/`;
  if (status === 'ready') return { url, reused: true, close: async () => {} };
  if (status !== 'stopped') throw new Error(`Port ${port} is occupied or unresponsive. No process was stopped. Try another PORT.`);
  const lab = createLabServer(options);
  try {
    await new Promise((yes, no) => {
      lab.server.once('error', no);
      lab.server.listen(port, '127.0.0.1', () => { lab.server.off('error', no); yes(); });
    });
    if (await inspectService(port) !== 'ready') throw new Error('Service started but readiness check failed.');
  } catch (error) { await lab.close().catch(() => {}); throw error; }
  return { url, reused: false, close: lab.close };
}

function openBrowser(url) {
  const commands = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((yes, no) => {
    const child = spawn(commands[0], commands[1], { stdio: 'ignore', windowsHide: true, detached: true, shell: false });
    child.once('error', no); child.once('spawn', () => { child.unref(); yes(); });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspace = await startWorkspace();
    console.log(`Account Region Lab is ready: ${workspace.url}`);
    if (!workspace.reused) console.log('Keep this window open while using the app. Press Ctrl+C to stop.');
    if (!process.argv.includes('--no-open')) {
      try { await openBrowser(workspace.url); } catch { console.log(`Open this address in your browser: ${workspace.url}`); }
    }
    if (!workspace.reused) for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => workspace.close().finally(() => process.exit(0)));
  } catch (error) {
    console.error(`Unable to start Account Region Lab: ${error.message}`);
    process.exitCode = 1;
  }
}
