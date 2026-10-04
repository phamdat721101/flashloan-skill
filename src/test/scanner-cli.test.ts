import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('EDGE-05 scan mode rejects execution flags before loading config or contacting RPC', async () => {
  await assert.rejects(
    () => run(process.execPath, ['dist/cli.js', 'scan', '--live'], { cwd: process.cwd() }),
    (error: unknown) => {
      const message = String((error as { stderr?: string }).stderr ?? error);
      return /scan is read-only/.test(message);
    }
  );
});
