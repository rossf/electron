'use strict';
// Copyright (c) 2026 Electron contributors.
// Use of this source code is governed by the MIT license in the LICENSE file.
// Browser-owned synthetic creation. The native test binding replaces all
// authenticators and Bluetooth before any WebAuthn request is made.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const mode = process.env.PASSKEY_CREATION_TEST_MODE;
assert.ok(['enabled', 'creation-disabled', 'backend-disabled', 'disabled', 'shutdown'].includes(mode));
assert.ok(process.env.HYBRID_TEST_PROFILE && process.env.HYBRID_TEST_RESULT);
const enabled = ['enabled', 'shutdown'].includes(mode);
const result = {
  ok: false,
  completed: false,
  syntheticOnly: true,
  runId: process.env.PASSKEY_BROWSER_TEST_RUN_ID,
  mode,
  tests: [],
  productionDevicesUsed: false
};
const save = () => fs.writeFileSync(process.env.HYBRID_TEST_RESULT, JSON.stringify(result, null, 2));
const fatal = (error) => {
  console.error(error);
  save();
  app.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
app.setPath('userData', path.resolve(process.env.HYBRID_TEST_PROFILE));
app.setPath('sessionData', app.getPath('userData'));
for (const [name, directory] of [
  ['userCache', 'cache'],
  ['logs', 'logs'],
  ['crashDumps', 'crashes']
]) {
  const target = path.join(app.getPath('userData'), directory);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
}
app.enableSandbox();
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
if (!['backend-disabled', 'disabled'].includes(mode)) app.commandLine.appendSwitch('enable-electron-webauthn-hybrid');
if (!['creation-disabled', 'disabled'].includes(mode)) {
  app.commandLine.appendSwitch('enable-electron-webauthn-hybrid-creation');
}
app.on('window-all-closed', () => {});
const serve = (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Security-Policy': "default-src 'none'; frame-src http://localhost:*"
  });
  res.end('<!doctype html><title>Synthetic passkey creation</title>');
};
const server = http.createServer(serve),
  frameServer = http.createServer(serve);
const pause = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  throw new Error(message);
}
app
  .whenReady()
  .then(async () => {
    const binding = process._linkedBinding('electron_hybrid_browser_owned_testing');
    await Promise.all([
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
      new Promise((resolve) => frameServer.listen(0, '127.0.0.1', resolve))
    ]);
    const origin = `http://localhost:${server.address().port}`;
    const childOrigin = `http://localhost:${frameServer.address().port}`;
    const allowed = new Set([origin, childOrigin]);
    function makeSession(name) {
      const ses = session.fromPartition(name);
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !allowed.has(new URL(details.url).origin) })
      );
      return ses;
    }
    const ses = makeSession('synthetic-creation');
    const otherSession = makeSession('synthetic-creation-other');
    const windows = new Set();
    async function window(targetSession = ses) {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { session: targetSession, sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      windows.add(win);
      win.on('closed', () => windows.delete(win));
      await win.loadURL(origin);
      return win;
    }
    const initial = await window();
    binding.install(initial.webContents.mainFrame.processId, initial.webContents.mainFrame.routingId);
    initial.destroy();
    async function idle() {
      await until(() => {
        const s = binding.stats();
        return s.live === 0 && s.observers === 0;
      }, 'Native discovery/adapter observer leak');
    }
    async function start(target, options = {}) {
      const challenge = crypto.randomBytes(32).toString('base64url');
      const settings = {
        challenge,
        rp: 'localhost',
        residentKey: 'required',
        userVerification: 'required',
        attachment: 'cross-platform',
        algorithms: [-7],
        timeout: 1000,
        ...options
      };
      await target.executeJavaScript(
        `(() => {
      const settings = ${JSON.stringify(settings)};
      globalThis.controller = new AbortController(); globalThis.outcome = null;
      const publicKey = {
        rp: { id: settings.rp, name: 'Synthetic test' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'synthetic-user', displayName: 'Synthetic' },
        challenge: Uint8Array.from(atob(settings.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
        pubKeyCredParams: settings.algorithms.map(alg => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: settings.residentKey, userVerification: settings.userVerification },
        extensions: { credProps: true }, attestation: 'none', timeout: settings.timeout
      };
      if (settings.attachment !== 'any') publicKey.authenticatorSelection.authenticatorAttachment = settings.attachment;
      if (settings.exclude) publicKey.excludeCredentials = [{ type: 'public-key', id: Uint8Array.from(settings.exclude), transports: ['hybrid'] }];
      const request = { signal: controller.signal, publicKey };
      if (settings.mediation) request.mediation = settings.mediation;
      navigator.credentials.create(request).then(c => {
        const bytes = b => Array.from(new Uint8Array(b));
        globalThis.outcome = { ok: true, id: bytes(c.rawId), clientDataJSON: bytes(c.response.clientDataJSON),
          authData: bytes(c.response.getAuthenticatorData()), key: bytes(c.response.getPublicKey()),
          algorithm: c.response.getPublicKeyAlgorithm(), attachment: c.authenticatorAttachment,
          extensions: c.getClientExtensionResults(), transports: c.response.getTransports() };
      }, e => { globalThis.outcome = { ok: false, name: e.name }; }); return true;
    })()`,
        true
      );
      return challenge;
    }
    async function settled(target) {
      let value;
      await until(async () => {
        value = await target.executeJavaScript('globalThis.outcome');
        return value;
      }, 'Creation request did not settle');
      return value;
    }
    function verifyRegistration(
      value,
      challenge,
      crossOrigin = false,
      requireUV = true,
      attachment = 'cross-platform'
    ) {
      assert.equal(value.ok, true, value.name);
      const client = JSON.parse(Buffer.from(value.clientDataJSON));
      assert.equal(client.type, 'webauthn.create');
      assert.equal(client.challenge, challenge);
      assert.equal(client.origin, crossOrigin ? childOrigin : origin);
      assert.equal(client.crossOrigin, crossOrigin);
      if (crossOrigin) assert.equal(client.topOrigin, origin);
      const data = Buffer.from(value.authData);
      assert.deepEqual(data.subarray(0, 32), crypto.createHash('sha256').update('localhost').digest());
      assert.equal(data[32] & 1, 1);
      if (requireUV) assert.equal(data[32] & 4, 4);
      assert.equal(data[32] & 64, 64, 'Registration must contain attested credential data');
      const idLength = data.readUInt16BE(53);
      assert.deepEqual(data.subarray(55, 55 + idLength), Buffer.from(value.id));
      assert.equal(value.algorithm, -7);
      assert.equal(value.attachment, attachment);
      assert.ok(value.id.length && value.key.length);
      return value;
    }
    async function assertion(target, registration) {
      const challenge = crypto.randomBytes(32).toString('base64url');
      const value = await target.executeJavaScript(
        `(async () => {
      const c = await navigator.credentials.get({ signal: AbortSignal.timeout(5000), publicKey: {
        rpId: 'localhost', challenge: Uint8Array.from(atob(${JSON.stringify(challenge.replace(/-/g, '+').replace(/_/g, '/'))}), c => c.charCodeAt(0)),
        allowCredentials: [{ type: 'public-key', id: Uint8Array.from(${JSON.stringify(registration.id)}), transports: ['hybrid'] }],
        userVerification: 'required'
      }});
      return Object.fromEntries(['clientDataJSON', 'authenticatorData', 'signature'].map(k => [k, Array.from(new Uint8Array(c.response[k]))]));
    })()`,
        true
      );
      const client = Buffer.from(value.clientDataJSON),
        data = JSON.parse(client),
        auth = Buffer.from(value.authenticatorData);
      assert.equal(data.type, 'webauthn.get');
      assert.equal(data.challenge, challenge);
      assert.equal(data.origin, origin);
      assert.deepEqual(auth.subarray(0, 32), crypto.createHash('sha256').update('localhost').digest());
      assert.equal(auth[32] & 5, 5);
      const key = crypto.createPublicKey({ key: Buffer.from(registration.key), format: 'der', type: 'spki' });
      assert.ok(
        crypto.verify(
          'sha256',
          Buffer.concat([auth, crypto.createHash('sha256').update(client).digest()]),
          key,
          Buffer.from(value.signature)
        )
      );
    }
    if (mode === 'shutdown') {
      app.on('will-quit', () => {
        try {
          assert.equal(binding.stats().live, 0);
          assert.equal(binding.stats().observers, 0);
          binding.uninstall();
          result.shutdownTeardownVerified = true;
          save();
        } catch (error) {
          fatal(error);
        }
      });
      const win = await window();
      binding.prepareCreation(true, false, true, true, true, true);
      ses.setWebAuthnHybridHandler((details) => {
        try {
          if (details.state !== 'ready') return true;
          assert.equal(details.requestType, 'create');
          assert.equal(binding.qrRequestType(details.qrCode), 'create');
          assert.ok(binding.stats().live > 0);
          result.tests.push({ name: 'app-quit-with-pending-creation', ok: true });
          result.shutdownRequested = true;
          result.completed = true;
          result.ok = true;
          save();
          setImmediate(() => app.quit());
        } catch (error) {
          fatal(error);
        }
        return true;
      });
      await start(win.webContents, { timeout: 10000 });
      setTimeout(() => app.exit(2), 10000);
      return;
    }
    const cases = enabled
      ? [
          ['hybrid-create-and-assert', {}],
          ['attachment-any', { attachment: 'any' }],
          ['resident-preferred', { residentKey: 'preferred' }],
          ['resident-discouraged', { residentKey: 'discouraged' }],
          ['uv-preferred', { userVerification: 'preferred' }],
          ['uv-discouraged', { userVerification: 'discouraged' }],
          ['algorithm-fallback', { algorithms: [-257, -7] }],
          ['exclude-existing', {}],
          ['unowned-usb', {}],
          ['other-session-usb', {}],
          ['ble-off-usb', {}],
          ['wrong-rp', { rp: 'unrelated.example' }],
          ['unsupported-algorithm', { algorithms: [-999] }],
          ['resident-required-unsupported', {}],
          ['uv-required-unsupported', {}],
          ['uv-failure', {}],
          ['platform-only', { attachment: 'platform' }],
          ['platform-success', { attachment: 'platform' }],
          ['conditional', { mediation: 'conditional', attachment: 'any' }],
          ['policy-denied', {}],
          ['policy-allowed', {}],
          ['sync-cancel', {}],
          ['stale-cancel', {}],
          ['handler-false', {}],
          ['handler-promise', {}],
          ['handler-throw', {}],
          ['owner-replaced', {}],
          ['page-abort', {}],
          ['timeout', {}],
          ['ble-recovery', {}],
          ['navigate', {}],
          ['destroy', {}],
          ['iframe-remove', {}]
        ]
      : [['default-off-existing-usb', {}]];
    let staleCancel;
    for (const [name, options] of cases) {
      const entry = { name, ok: false };
      result.tests.push(entry);
      const win = await window(name === 'other-session-usb' ? otherSession : ses);
      let target = win.webContents,
        targetFrame = win.webContents.mainFrame;
      const events = [],
        errors = [];
      let cancel;
      let expectedType = 'create';
      const unowned = ['unowned-usb', 'other-session-usb'].includes(name);
      const noOwner =
        !enabled ||
        unowned ||
        ['wrong-rp', 'platform-only', 'platform-success', 'conditional', 'policy-denied'].includes(name);
      const teardown = ['navigate', 'destroy', 'iframe-remove'].includes(name);
      const held = [
        'sync-cancel',
        'stale-cancel',
        'handler-false',
        'handler-promise',
        'handler-throw',
        'owner-replaced',
        'page-abort',
        'timeout',
        'ble-recovery',
        'navigate',
        'destroy',
        'iframe-remove'
      ].includes(name);
      const hybrid = enabled && !unowned && !['ble-off-usb', 'platform-success'].includes(name);
      if (['policy-denied', 'policy-allowed', 'iframe-remove'].includes(name)) {
        const frameOrigin = name === 'iframe-remove' ? origin : childOrigin;
        await win.webContents.executeJavaScript(`new Promise(resolve => {
        const f = document.createElement('iframe'); f.id = 'creation-frame'; f.onload = () => resolve(true);
        f.src = ${JSON.stringify(frameOrigin)};
        if (${JSON.stringify(name)} === 'policy-allowed') f.allow = 'publickey-credentials-create';
        document.body.appendChild(f);
      })`);
        targetFrame = win.webContents.mainFrame.frames.find((f) => new URL(f.url).origin === frameOrigin);
        assert.ok(targetFrame);
        target = targetFrame;
      }
      const frameId = { process: targetFrame.processId, routing: targetFrame.routingId };
      const expectedOrigin = name.startsWith('policy-') ? childOrigin : origin;
      binding.prepareCreation(
        !['ble-off-usb', 'ble-recovery'].includes(name),
        !held,
        hybrid,
        name !== 'resident-required-unsupported',
        name !== 'uv-required-unsupported',
        name !== 'uv-failure'
      );
      if (name === 'platform-success') binding.preparePlatform();
      ses.setWebAuthnHybridHandler(
        name === 'unowned-usb'
          ? null
          : (details, currentCancel) => {
              events.push({ state: details.state, id: details.requestId, type: details.requestType });
              try {
                assert.equal(details.requestType, expectedType);
                if (details.state === 'ended') {
                  assert.equal(currentCancel, undefined);
                  return true;
                }
                assert.equal(details.origin, expectedOrigin);
                assert.equal(details.relyingPartyId, 'localhost');
                assert.equal(details.frame.processId, frameId.process);
                assert.equal(details.frame.routingId, frameId.routing);
                assert.equal(typeof currentCancel, 'function');
                cancel = currentCancel;
                if (details.state === 'ready') assert.equal(binding.qrRequestType(details.qrCode), expectedType);
                else {
                  assert.equal(details.state, 'unavailable');
                  assert.equal(details.qrCode, '');
                }
                if (name === 'sync-cancel') {
                  staleCancel = currentCancel;
                  currentCancel();
                  currentCancel();
                }
                if (name === 'stale-cancel') {
                  assert.equal(typeof staleCancel, 'function');
                  staleCancel();
                }
                if (name === 'handler-false') return false;
                if (name === 'handler-promise') return Promise.resolve(true);
                if (name === 'handler-throw') throw new Error('synthetic-owner-failure');
                if (name === 'navigate') win.loadURL(origin + '/next').catch((e) => errors.push(e));
                if (name === 'destroy') win.destroy();
                if (name === 'iframe-remove') {
                  win.webContents
                    .executeJavaScript("document.querySelector('#creation-frame').remove()")
                    .catch((e) => errors.push(e));
                }
              } catch (error) {
                if (name === 'handler-throw' && error.message === 'synthetic-owner-failure') throw error;
                errors.push(error);
              }
              return true;
            }
      );
      try {
        let challenge;
        try {
          challenge = await start(target, { timeout: held && name !== 'timeout' ? 5000 : 1000, ...options });
        } catch (error) {
          if (!teardown || !events.some((e) => e.state === 'ready')) throw error;
        }
        if (teardown) {
          await until(() => events.some((e) => e.state === 'ended'), 'No terminal update after frame teardown');
        } else if (
          held &&
          !['sync-cancel', 'handler-false', 'handler-promise', 'handler-throw', 'timeout'].includes(name)
        ) {
          await until(() => cancel, 'Missing creation owner callback');
          if (name === 'owner-replaced') {
            ses.setWebAuthnHybridHandler(() => {
              errors.push(new Error('Replacement stole creation'));
              return true;
            });
          }
          if (name === 'ble-recovery') {
            assert.equal(events.at(-1).state, 'unavailable');
            binding.setPowered(true);
            await until(() => events.some((e) => e.state === 'ready'), 'No recovery update');
          }
          if (name === 'page-abort') await target.executeJavaScript('controller.abort()');
          else {
            cancel();
            cancel();
          }
          assert.equal((await settled(target)).name, name === 'page-abort' ? 'AbortError' : 'NotAllowedError');
        } else if (held) assert.equal((await settled(target)).name, 'NotAllowedError');
        else if (name === 'conditional') {
          await pause(100);
          await target.executeJavaScript('controller.abort()');
          const value = await settled(target);
          assert.equal(value.ok, false);
          assert.ok(['AbortError', 'NotAllowedError', 'NotSupportedError'].includes(value.name));
        } else if (
          [
            'wrong-rp',
            'unsupported-algorithm',
            'resident-required-unsupported',
            'uv-required-unsupported',
            'uv-failure',
            'platform-only',
            'policy-denied'
          ].includes(name)
        ) {
          const value = await settled(target);
          assert.equal(value.ok, false);
          assert.equal(value.name, name === 'wrong-rp' ? 'SecurityError' : 'NotAllowedError');
        } else {
          const registration = verifyRegistration(
            await settled(target),
            challenge,
            name === 'policy-allowed',
            options.userVerification !== 'discouraged',
            name === 'platform-success' ? 'platform' : 'cross-platform'
          );
          if (!['discouraged'].includes(options.residentKey)) assert.equal(registration.extensions.credProps.rk, true);
          if (name === 'platform-success') {
            assert.ok(binding.stats().platformDevices > 0);
            assert.equal(binding.stats().hybridDevices, 0);
            assert.equal(binding.stats().usbDevices, 0);
          } else if (hybrid) {
            assert.ok(binding.stats().hybridDevices > 0);
            assert.equal(binding.stats().usbDevices, 0);
          } else assert.ok(binding.stats().usbDevices > 0);
          await idle();
          if (!noOwner) {
            await until(() => events.some((e) => e.state === 'ended'), 'Missing registration terminal update');
          }
          if (name === 'hybrid-create-and-assert') {
            expectedType = 'get';
            binding.prepareCreation(true, true, true, true, true, true);
            await assertion(target, registration);
            await idle();
            await until(
              () => events.some((e) => e.state === 'ended' && e.type === 'get'),
              'Missing assertion terminal update'
            );
            assert.equal(binding.stats().requestType, 'get');
          }
          if (name === 'exclude-existing') {
            binding.prepareCreation(true, true, true, true, true, true);
            await start(target, { exclude: registration.id });
            const value = await settled(target);
            assert.equal(value.ok, false);
            assert.equal(value.name, 'InvalidStateError');
          }
        }
        await idle();
        if (noOwner) {
          assert.equal(events.length, 0);
          if (!['platform-only', 'platform-success'].includes(name)) assert.equal(binding.stats().configured, 0);
          assert.equal(binding.stats().hybridDevices, 0);
        } else {
          const expectedRequests = ['hybrid-create-and-assert', 'exclude-existing'].includes(name) ? 2 : 1;
          await until(
            () => events.filter((e) => e.state === 'ended').length === expectedRequests,
            'Missing terminal owner update'
          );
          const ids = new Set(events.map((e) => e.id));
          assert.equal(ids.size, ['hybrid-create-and-assert', 'exclude-existing'].includes(name) ? 2 : 1);
          for (const id of ids) assert.equal(events.filter((e) => e.id === id && e.state === 'ended').length, 1);
        }
        assert.equal(errors.length, 0, errors.map((e) => e.stack).join('\n'));
        assert.equal(binding.stats().mockFailed, false);
        entry.ok = true;
      } catch (error) {
        entry.error = error.stack || String(error);
      } finally {
        if (!win.isDestroyed()) {
          await target.executeJavaScript('globalThis.controller?.abort()').catch(() => {});
          win.destroy();
        }
        await idle();
        ses.setWebAuthnHybridHandler(null);
        entry.states = events.map((e) => ({ state: e.state, type: e.type }));
        entry.stats = binding.stats();
        save();
      }
    }
    binding.uninstall();
    assert.equal(windows.size, 0);
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => frameServer.close(resolve))
    ]);
    result.completed = true;
    result.ok = result.tests.every((test) => test.ok);
    save();
    for (const test of result.tests.filter((test) => !test.ok)) console.error(test.name, test.error);
    app.exit(result.ok ? 0 : 1);
  })
  .catch(fatal);
