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
assert.ok(['enabled', 'no-handler', 'shutdown'].includes(mode));
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
        webPreferences: {
          session: targetSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
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
      verifyAssertion(value, challenge, registration);
    }
    function verifyAssertion(value, challenge, registration) {
      const client = Buffer.from(value.clientDataJSON),
        data = JSON.parse(client),
        auth = Buffer.from(value.authenticatorData);
      assert.equal(data.type, 'webauthn.get');
      assert.equal(data.challenge, challenge);
      assert.equal(data.origin, origin);
      assert.equal(data.crossOrigin, false);
      assert.deepEqual(auth.subarray(0, 32), crypto.createHash('sha256').update('localhost').digest());
      assert.equal(auth[32] & 5, 5);
      const key = crypto.createPublicKey({
        key: Buffer.from(registration.key),
        format: 'der',
        type: 'spki'
      });
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
      const win = await window();
      binding.prepareCreation(true, false, true, true, true, true);
      ses.setWebAuthnHybridHandler((details) => {
        try {
          if (details.state !== 'ready') return;
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
          ['handler-object', {}],
          ['handler-undefined', {}],
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
      : [['no-handler-existing-usb', {}]];
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
        'handler-object',
        'handler-undefined',
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
        !enabled || name === 'unowned-usb'
          ? null
          : (details, currentCancel) => {
              events.push({
                state: details.state,
                id: details.requestId,
                type: details.requestType
              });
              try {
                assert.equal(details.requestType, expectedType);
                if (details.state === 'ended') {
                  assert.equal(currentCancel, undefined);
                  return;
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
                if (name === 'handler-object') return {};
                if (name === 'handler-undefined') return;
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
                currentCancel?.();
              }
            }
      );
      try {
        let challenge;
        try {
          challenge = await start(target, {
            timeout: held && name !== 'timeout' ? 5000 : 1000,
            ...options
          });
        } catch (error) {
          if (!teardown || !events.some((e) => e.state === 'ready')) throw error;
        }
        if (teardown) {
          await until(() => events.some((e) => e.state === 'ended'), 'No terminal update after frame teardown');
        } else if (held && !['sync-cancel', 'handler-throw', 'timeout'].includes(name)) {
          await until(() => cancel, 'Missing creation owner callback');
          if (name.startsWith('handler-')) {
            await pause(50);
            assert.ok(binding.stats().live > 0, 'Ignored return keeps native discovery alive');
            assert.ok(!events.some((event) => event.state === 'ended'));
            assert.equal(await target.executeJavaScript('globalThis.outcome'), null, 'Return values do not cancel');
          }
          if (name === 'owner-replaced') {
            ses.setWebAuthnHybridHandler(() => {
              errors.push(new Error('Replacement stole creation'));
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
    if (enabled) {
      for (const affectedType of ['create', 'get']) {
        for (const action of ['cancel', 'navigate']) {
          const entry = { name: `concurrent-${affectedType}-${action}`, ok: false };
          result.tests.push(entry);
          const createWindow = await window(),
            getWindow = await window();
          const events = [];
          try {
            // Keep discoveries alive without devices: this tests request/UI
            // ownership independently of credential or transport completion.
            binding.preparePending();
            ses.setWebAuthnHybridHandler((details, cancel) => {
              events.push({
                id: details.requestId,
                type: details.requestType,
                state: details.state,
                origin: details.origin,
                rp: details.relyingPartyId,
                processId: details.frame?.processId,
                routingId: details.frame?.routingId,
                cancel
              });
            });
            await start(createWindow.webContents, { timeout: 30000 });
            await getWindow.webContents.executeJavaScript(
              `(() => {
                globalThis.controller = new AbortController(); globalThis.outcome = null;
                navigator.credentials.get({ signal: controller.signal, publicKey: {
                  rpId: 'localhost', challenge: crypto.getRandomValues(new Uint8Array(32)),
                  allowCredentials: [{ type: 'public-key', id: Uint8Array.of(1), transports: ['hybrid'] }],
                  userVerification: 'required', timeout: 30000
                }}).then(() => { globalThis.outcome = { ok: true }; },
                  e => { globalThis.outcome = { ok: false, name: e.name }; });
                return true;
              })()`,
              true
            );
            await until(
              () =>
                ['create', 'get'].every((type) =>
                  events.some((event) => event.type === type && event.state === 'ready')
                ),
              'Both create and get must become independently owned'
            );
            const requests = new Map();
            for (const [type, win] of [
              ['create', createWindow],
              ['get', getWindow]
            ]) {
              const request = events.find((event) => event.type === type && event.state === 'ready');
              assert.equal(request.origin, origin);
              assert.equal(request.rp, 'localhost');
              assert.equal(request.processId, win.webContents.mainFrame.processId);
              assert.equal(request.routingId, win.webContents.mainFrame.routingId);
              assert.equal(typeof request.cancel, 'function');
              assert.equal(await win.webContents.executeJavaScript('globalThis.outcome'), null);
              requests.set(type, { ...request, win });
            }
            assert.notEqual(requests.get('create').id, requests.get('get').id);
            assert.equal(binding.stats().usbDevices, 0);
            assert.equal(binding.stats().hybridDevices, 0);
            assert.equal(binding.stats().platformDevices, 0);
            const affected = requests.get(affectedType),
              survivor = requests.get(affectedType === 'create' ? 'get' : 'create');
            if (action === 'cancel') {
              affected.cancel();
              affected.cancel();
              assert.equal((await settled(affected.win.webContents)).name, 'NotAllowedError');
            } else {
              await affected.win.loadURL(origin + '/concurrent-navigation');
            }
            await until(
              () => events.some((event) => event.id === affected.id && event.state === 'ended'),
              'Affected request must end after cancellation or navigation'
            );
            affected.cancel();
            affected.cancel();
            // Allow posted terminal notifications to run before checking that
            // duplicate/stale handles did not settle the other window's request.
            await pause(50);
            assert.equal(await survivor.win.webContents.executeJavaScript('globalThis.outcome'), null);
            assert.ok(!events.some((event) => event.id === survivor.id && event.state === 'ended'));
            assert.ok(binding.stats().live > 0, 'Surviving request retains native discovery');
            survivor.cancel();
            survivor.cancel();
            assert.equal((await settled(survivor.win.webContents)).name, 'NotAllowedError');
            await idle();
            await until(
              () =>
                [...requests.values()].every((request) =>
                  events.some((event) => event.id === request.id && event.state === 'ended')
                ),
              'Both requests require terminal notifications'
            );
            assert.equal(new Set(events.map((event) => event.id)).size, 2);
            for (const [type, request] of requests) {
              const updates = events.filter((event) => event.id === request.id);
              assert.ok(updates.every((event) => event.type === type));
              const terminal = updates.filter((event) => event.state === 'ended');
              assert.equal(terminal.length, 1);
              assert.equal(terminal[0].cancel, undefined);
            }
            assert.equal(binding.stats().mockFailed, false);
            entry.ok = true;
          } catch (error) {
            entry.error = error.stack || String(error);
          } finally {
            for (const win of [createWindow, getWindow]) {
              if (!win.isDestroyed()) {
                await win.webContents.executeJavaScript('globalThis.controller?.abort()').catch(() => {});
                win.destroy();
              }
            }
            await idle();
            ses.setWebAuthnHybridHandler(null);
            entry.states = events.map((event) => ({ state: event.state, type: event.type }));
            entry.stats = binding.stats();
            save();
          }
        }
      }
    }
    if (enabled) {
      const raceDrained = () => {
        const stats = binding.stats();
        return (
          !stats.usbRace ||
          ['usbRace', 'hybridRace'].every((name) => {
            const endpoint = stats[name];
            return (
              !endpoint.pending &&
              endpoint.held === endpoint.delivered &&
              endpoint.inFlight === 0 &&
              endpoint.liveDevices === 0
            );
          })
        );
      };
      for (const requestType of ['create', 'get']) {
        for (const winner of ['usb', 'hybrid']) {
          const loser = winner === 'usb' ? 'hybrid' : 'usb';
          const entry = { name: `race-${requestType}-${winner}-first`, ok: false };
          result.tests.push(entry);
          const win = await window();
          const events = [];
          try {
            const credentials = binding.prepareRace();
            ses.setWebAuthnHybridHandler((details, cancel) => {
              events.push({ id: details.requestId, type: details.requestType, state: details.state, cancel });
            });
            let challenge;
            if (requestType === 'create') {
              challenge = await start(win.webContents, { timeout: 30000 });
            } else {
              challenge = crypto.randomBytes(32).toString('base64url');
              await win.webContents.executeJavaScript(
                `(() => {
                  globalThis.controller = new AbortController(); globalThis.outcome = null;
                  navigator.credentials.get({ signal: controller.signal, publicKey: {
                    rpId: 'localhost',
                    challenge: Uint8Array.from(atob(${JSON.stringify(challenge.replace(/-/g, '+').replace(/_/g, '/'))}), c => c.charCodeAt(0)),
                    allowCredentials: ${JSON.stringify([credentials.usbId, credentials.hybridId])}.map(id => ({
                      type: 'public-key', id: Uint8Array.from(id), transports: ['usb', 'hybrid']
                    })), userVerification: 'required', timeout: 30000
                  }}).then(c => {
                    const bytes = b => Array.from(new Uint8Array(b));
                    globalThis.outcome = { ok: true, id: bytes(c.rawId), clientDataJSON: bytes(c.response.clientDataJSON),
                      authenticatorData: bytes(c.response.authenticatorData), signature: bytes(c.response.signature) };
                  }, e => { globalThis.outcome = { ok: false, name: e.name }; });
                  return true;
                })()`,
                true
              );
            }
            await until(() => {
              const stats = binding.stats();
              return stats.usbRace.pending && stats.hybridRace.pending;
            }, 'Both transports must hold successful CTAP responses');
            const held = binding.stats();
            assert.equal(held.usbDevices, 1);
            assert.equal(held.hybridDevices, 1);
            assert.equal(held.platformDevices, 0);
            for (const endpoint of [held.usbRace, held.hybridRace]) {
              assert.equal(endpoint.held, 1);
              assert.equal(endpoint.delivered, 0);
              assert.equal(endpoint.inFlight, 0);
              assert.equal(endpoint.liveDevices, 1);
            }
            assert.equal(await win.webContents.executeJavaScript('globalThis.outcome'), null);
            await until(() => events.some((event) => event.state === 'ready'), 'Hybrid UI must own the mixed request');
            assert.ok(!events.some((event) => event.state === 'ended'));
            binding.releaseRaceResponse(winner);
            const value = await settled(win.webContents);
            if (requestType === 'create') {
              verifyRegistration(value, challenge);
            } else {
              assert.equal(value.ok, true, value.name);
              assert.deepEqual(value.id, credentials[winner + 'Id']);
              verifyAssertion(value, challenge, { key: credentials[winner + 'Key'] });
            }
            await idle();
            await until(() => events.some((event) => event.state === 'ended'), 'Winning response must end the request');
            const finished = binding.stats();
            assert.equal(finished[winner + 'Race'].delivered, 1);
            assert.equal(finished[loser + 'Race'].delivered, 0);
            assert.equal(finished[loser + 'Race'].pending, true);
            assert.ok(finished[loser + 'Race'].cancellations > 0, 'Losing operation must receive cancellation');
            assert.equal(finished.usbRace.liveDevices, 0);
            assert.equal(finished.hybridRace.liveDevices, 0);
            assert.equal(events.filter((event) => event.state === 'ended').length, 1);
            const eventCount = events.length;
            // The original native callback still runs after its operation and
            // device are gone. Its weak receiver must safely drop the response.
            binding.releaseRaceResponse(loser);
            await until(raceDrained, 'Late losing response must actually be delivered');
            await pause(50);
            assert.deepEqual(await win.webContents.executeJavaScript('globalThis.outcome'), value);
            assert.equal(events.length, eventCount);
            assert.equal(new Set(events.map((event) => event.id)).size, 1);
            assert.ok(events.every((event) => event.type === requestType));
            const terminal = events.filter((event) => event.state === 'ended');
            assert.equal(terminal.length, 1);
            assert.equal(terminal[0].cancel, undefined);
            for (const endpoint of [binding.stats().usbRace, binding.stats().hybridRace]) {
              assert.equal(endpoint.held, 1);
              assert.equal(endpoint.delivered, 1);
            }
            await idle();
            assert.equal(binding.stats().mockFailed, false);
            entry.ok = true;
          } catch (error) {
            entry.error = error.stack || String(error);
          } finally {
            if (!win.isDestroyed()) {
              await win.webContents.executeJavaScript('globalThis.controller?.abort()').catch(() => {});
              win.destroy();
            }
            await idle();
            await until(() => {
              for (const transport of ['usb', 'hybrid']) {
                if (binding.stats()[transport + 'Race']?.pending) binding.releaseRaceResponse(transport);
              }
              return raceDrained();
            }, 'Drain in-flight and held responses before resetting the mock');
            ses.setWebAuthnHybridHandler(null);
            entry.states = events.map((event) => ({ state: event.state, type: event.type }));
            entry.stats = binding.stats();
            save();
          }
        }
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
