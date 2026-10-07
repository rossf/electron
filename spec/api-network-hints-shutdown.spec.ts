import { expect } from 'chai';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defer } from './lib/spec-helpers.ts';

describe('network hints shutdown', { tags: ['serial'] }, () => {
  for (const mode of ['no-hover', 'hover', 'preconnect', 'preconnect-anonymous']) {
    it(`exits cleanly after ${mode}`, async () => {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-network-hints-'));
      defer(() => fs.rmSync(profile, { recursive: true, force: true }));
      const fixture = path.join(import.meta.dirname, 'fixtures/api/network-hints-shutdown/main.cjs');
      const child = spawn(process.execPath, [fixture, `--test-mode=${mode}`, `--user-data-dir=${profile}`], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      defer(async () => {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill();
          await once(child, 'close');
        }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const [code, signal] = await once(child, 'close');
      expect(stdout).to.include(`network-hints-ready:${mode}\n`);
      expect(signal, stderr).to.equal(null);
      expect(code, stderr).to.equal(0);
    });
  }
});
