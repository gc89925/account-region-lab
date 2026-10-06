#!/usr/bin/env node
import { randomBytes, scryptSync } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 4096) throw new Error('Password input is too long.');
      chunks.push(chunk);
    }
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (/[\r\n]/.test(value)) throw new Error('Provide exactly one password line on stdin.');
    return value;
  }
  return new Promise((resolve, reject) => {
    let password = '';
    const wasRaw = process.stdin.isRaw;
    function finish(error) {
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(password);
    }
    function keypress(text, key = {}) {
      if ((key.ctrl && ['c','d'].includes(key.name)) || key.name === 'escape') return finish(new Error('Cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        if (password) { password = Array.from(password).slice(0,-1).join(''); process.stderr.write('\b \b'); }
        return;
      }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) {
        if (Buffer.byteLength(password + text) > 1024) return;
        password += text;
        process.stderr.write('*'.repeat(Array.from(text).length));
      }
    }
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', keypress);
    process.stdin.resume();
    process.stderr.write('Gateway password (at least 16 characters): ');
  });
}

async function main() {
  const [output = '/var/lib/account-region-lab/access.json', username = 'admin', ...extra] = process.argv.slice(2);
  if (extra.length || !isAbsolute(output) || !username || username.length > 80 || /[\x00-\x1f\x7f]/.test(username)) {
    throw new Error('Usage: create-access.mjs [absolute-output-path] [username]');
  }
  const password = await readPassword();
  if (Array.from(password).length < 16 || Buffer.byteLength(password) > 1024 || /[\x00-\x1f\x7f]/.test(password)) {
    throw new Error('Use a password of at least 16 characters, at most 1024 UTF-8 bytes, without control characters.');
  }
  const salt = randomBytes(24).toString('hex');
  const passwordHash = scryptSync(password, Buffer.from(salt,'hex'), 32).toString('hex');
  let file;
  let created = false;
  try {
    file = await open(output, 'wx', 0o600);
    created = true;
    await file.writeFile(JSON.stringify({username,salt,passwordHash}) + '\n');
    await file.sync();
    await file.close();
    file = null;
  } catch (error) {
    await file?.close();
    if (created) await unlink(output);
    if (error.code === 'EEXIST') throw new Error('The access file already exists. It was not changed.');
    throw new Error('Unable to create the private access file. Check the parent directory and service-user permissions.');
  }
  process.stdout.write('Created private gateway access file. Passwords are never printed or stored in plaintext.\n');
}

main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
