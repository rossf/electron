'use strict';
// Synthetic browser-owned requests. Native binding substitutes every discovery
// transport and the Bluetooth adapter before any navigator.credentials call.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const enabled = process.env.PASSKEY_BROWSER_TEST_ENABLED !== '0';
const result = {
  ok: false,
  completed: false,
  runId: process.env.PASSKEY_BROWSER_TEST_RUN_ID,
  enabled,
  tests: [],
  productionDevicesUsed: false
};
function save() {
  fs.writeFileSync(process.env.HYBRID_TEST_RESULT, JSON.stringify(result, null, 2) + '\n');
}
function fatal(error) {
  result.fatal = error.stack || String(error);
  console.error(result.fatal);
  save();
  app.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
if (!process.env.HYBRID_TEST_PROFILE || !process.env.HYBRID_TEST_RESULT) {
  throw new Error('Disposable paths required');
}
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
  res.end('<!doctype html><title>Synthetic WebAuthn ownership test</title>');
};
const server = http.createServer(serve);
const frameServer = http.createServer(serve);
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(fn, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await pause();
  }
  throw new Error(message);
}
app
  .whenReady()
  .then(async () => {
    const binding = process._linkedBinding('electron_hybrid_browser_owned_testing');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => frameServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const childOrigin = `http://localhost:${frameServer.address().port}`;
    const allowedOrigins = new Set([origin, childOrigin]);
    const ses = session.fromPartition('browser-owned-synthetic');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !allowedOrigins.has(new URL(details.url).origin) })
    );
    assert.equal(typeof ses.setWebAuthnHybridHandler, 'function', 'Native hybrid handler API is required');
    assert.throws(() => ses.setWebAuthnHybridHandler(123), /null or function/);
    assert.throws(() => ses.setWebAuthnHybridHandler(undefined), /null or function/);
    const revision = 'session-handler-void';
    result.revision = revision;
    result.version = process.versions.electron;
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
    function owner(fn) {
      ses.setWebAuthnHybridHandler(enabled ? fn : null);
    }
    const first = await window();
    binding.install(first.webContents.mainFrame.processId, first.webContents.mainFrame.routingId);
    binding.prepare(true, true);
    owner(null);
    const registration = await first.webContents.executeJavaScript(
      `(async () => {
    const c = await navigator.credentials.create({ signal: AbortSignal.timeout(5000), publicKey: {
      rp: { id: 'localhost', name: 'Synthetic test' }, user: { id: Uint8Array.of(1), name: 'synthetic-user', displayName: 'Synthetic' },
      challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    }}); return { id: Array.from(new Uint8Array(c.rawId)), key: Array.from(new Uint8Array(c.response.getPublicKey())) };
  })()`,
      true
    );
    async function idle() {
      await until(() => {
        const s = binding.stats();
        return s.live === 0 && s.observers === 0;
      }, 'Native discovery/adapter observers leaked');
    }
    await idle();
    assert.equal(binding.stats().configured, 0, 'unowned create must not enter hybrid configuration');
    assert.ok(binding.stats().usbStarted > 0, 'create must use the existing synthetic USB registration path');
    assert.ok(registration.id.length && registration.key.length);
    result.tests.push({ name: 'unowned-create-uses-existing-registration', ok: true });
    owner(null);
    first.destroy();
    const consumed = new Set();
    function verify(assertion, challenge, crossOrigin = false) {
      assert.equal(assertion.ok, true, JSON.stringify(assertion));
      const client = Buffer.from(assertion.clientDataJSON),
        auth = Buffer.from(assertion.authenticatorData);
      const data = JSON.parse(client);
      assert.equal(data.type, 'webauthn.get');
      assert.equal(data.origin, crossOrigin ? childOrigin : origin);
      assert.equal(data.challenge, challenge);
      assert.equal(data.crossOrigin, crossOrigin);
      if (crossOrigin) assert.equal(data.topOrigin, origin);
      assert.deepEqual(auth.subarray(0, 32), crypto.createHash('sha256').update('localhost').digest());
      assert.equal(auth[32] & 5, 5, 'UP and UV required');
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
          Buffer.from(assertion.signature)
        )
      );
      assert.ok(!consumed.has(challenge), 'Synthetic RP refuses challenge replay');
      consumed.add(challenge);
    }
    async function start(win, rp = 'localhost', targetFrame = null) {
      const challenge = crypto.randomBytes(32).toString('base64url');
      await (targetFrame || win.webContents).executeJavaScript(
        `(() => {
      globalThis.controller = new AbortController(); globalThis.outcome = null;
      navigator.credentials.get({ signal: controller.signal, publicKey: {
        rpId: ${JSON.stringify(rp)}, challenge: Uint8Array.from(atob(${JSON.stringify(challenge.replace(/-/g, '+').replace(/_/g, '/'))}), c => c.charCodeAt(0)),
        allowCredentials: [{ type: 'public-key', id: Uint8Array.from(${JSON.stringify(registration.id)}), transports: ['usb', 'hybrid'] }], userVerification: 'required'
      }}).then(c => { globalThis.outcome = { ok: true, ...Object.fromEntries(['clientDataJSON', 'authenticatorData', 'signature'].map(k => [k, Array.from(new Uint8Array(c.response[k]))])) }; },
      e => { globalThis.outcome = { ok: false, name: e.name }; }); return true;
    })()`,
        true
      );
      return challenge;
    }
    async function outcome(win, targetFrame = null) {
      let value;
      await until(async () => {
        value = await (targetFrame || win.webContents).executeJavaScript('globalThis.outcome');
        return value;
      }, 'Credential did not settle');
      return value;
    }
    let oldCancel;
    const cases = enabled
      ? [
          ['unowned-usb-success', true, true],
          ['other-session-usb-success', true, true],
          ['owned-ble-off-usb-success', false, true],
          ['owned-repeat-first-usb-success', true, true],
          ['owned-repeat-second-usb-success', true, true],
          ['sync-cancel', true, false],
          ['stale-cancel', true, false],
          ['ble-loss-cancel', true, false],
          ['ble-recovery', false, false],
          ['handler-false', true, false],
          ['handler-object', true, false],
          ['handler-promise', true, false],
          ['handler-undefined', true, false],
          ['handler-throw', true, false],
          ['ended-throw', true, false],
          ['owner-replaced', true, false],
          ['owner-removed', true, false],
          ['navigate', true, false],
          ['destroy', true, false],
          ['iframe-remove', true, false],
          ['policy-denied', true, true],
          ['policy-allowed', true, true],
          ['wrong-rp', true, false],
          ['page-abort', true, false]
        ]
      : [
          ['unowned-usb-success', true, true],
          ['other-session-usb-success', true, true],
          ['no-handler-usb-success', true, true]
        ];
    for (const [name, powered, press] of cases) {
      const entry = { name, ok: false };
      result.tests.push(entry);
      let requestSession = ses;
      if (name === 'other-session-usb-success') {
        requestSession = session.fromPartition('browser-owned-other-session');
        requestSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        requestSession.setPermissionCheckHandler(() => false);
        requestSession.webRequest.onBeforeRequest((details, callback) =>
          callback({ cancel: !allowedOrigins.has(new URL(details.url).origin) })
        );
      }
      const win = await window(requestSession);
      const events = [];
      const errors = [];
      let cancel;
      let targetFrame = null;
      if (['iframe-remove', 'policy-denied', 'policy-allowed'].includes(name)) {
        const src = name === 'iframe-remove' ? origin : childOrigin;
        await win.webContents.executeJavaScript(`new Promise(resolve => {
        const frame = document.createElement('iframe'); frame.id = 'test-frame';
        frame.onload = () => resolve(true); frame.src = ${JSON.stringify(src)};
        if (${JSON.stringify(name)} === 'policy-allowed') frame.allow = 'publickey-credentials-get';
        document.body.appendChild(frame);
      })`);
        targetFrame = win.webContents.mainFrame.frames.find((frame) => new URL(frame.url).origin === src);
        assert.ok(targetFrame, 'Synthetic child frame exists');
      }
      const expectedRoutingId = (targetFrame || win.webContents.mainFrame).routingId;
      const expectedProcessId = (targetFrame || win.webContents.mainFrame).processId;
      const expectedOrigin = name.startsWith('policy-') ? childOrigin : origin;
      binding.prepare(powered, press);
      const handler = (details, currentCancel) => {
        try {
          events.push({ state: details.state, requestId: details.requestId });
          if (details.state === 'ended') {
            if (name === 'ended-throw') throw new Error('intentional terminal failure');
            return;
          }
          assert.equal(details.origin, expectedOrigin);
          assert.equal(details.relyingPartyId, 'localhost');
          assert.equal(details.frame.routingId, expectedRoutingId);
          assert.equal(details.frame.processId, expectedProcessId);
          assert.equal(typeof currentCancel, 'function');
          cancel = currentCancel;
          if (details.state === 'ready') assert.ok(details.qrCode.startsWith('FIDO:/'));
          else {
            assert.equal(details.state, 'unavailable');
            assert.equal(details.qrCode, '');
          }
          if (name === 'sync-cancel') {
            oldCancel = currentCancel;
            currentCancel();
            currentCancel();
          }
          if (name === 'stale-cancel') {
            assert.equal(typeof oldCancel, 'function');
            oldCancel();
          }
          if (name === 'handler-false') return false;
          if (name === 'handler-object') return {};
          if (name === 'handler-promise') return Promise.resolve(false);
          if (name === 'handler-undefined') return undefined;
          if (name === 'handler-throw') throw new Error('intentional handler failure');
          if (name === 'destroy') win.destroy();
          if (name === 'navigate') win.loadURL(origin + '/navigated').catch((e) => errors.push(e));
          if (name === 'iframe-remove') {
            win.webContents
              .executeJavaScript("document.querySelector('#test-frame').remove()")
              .catch((e) => errors.push(e));
          }
        } catch (error) {
          if (
            (name === 'handler-throw' && error.message === 'intentional handler failure') ||
            (name === 'ended-throw' && error.message === 'intentional terminal failure')
          ) {
            throw error;
          }
          errors.push(error);
          currentCancel?.();
        }
      };
      owner(name === 'unowned-usb-success' ? null : handler);
      try {
        let challenge;
        try {
          challenge = await start(win, name === 'wrong-rp' ? 'unrelated.example' : 'localhost', targetFrame);
        } catch (error) {
          if (!['destroy', 'navigate', 'iframe-remove'].includes(name) || !events.some((e) => e.state === 'ready')) {
            throw error;
          }
          entry.startInvalidatedByTeardown = true;
        }
        if (name.endsWith('usb-success')) {
          verify(await outcome(win), challenge);
          if (['unowned-usb-success', 'other-session-usb-success', 'no-handler-usb-success'].includes(name)) {
            assert.equal(binding.stats().configured, 0);
            assert.equal(events.length, 0);
          } else if (name === 'owned-ble-off-usb-success') {
            assert.ok(events.some((e) => e.state === 'unavailable'));
          } else assert.ok(events.some((e) => e.state === 'ready'));
        } else if (name === 'policy-denied') {
          const denied = await outcome(win, targetFrame);
          assert.equal(denied.ok, false);
          assert.equal(denied.name, 'NotAllowedError');
          assert.equal(binding.stats().configured, 0);
          assert.equal(binding.stats().usbStarted, 0);
        } else if (name === 'policy-allowed') {
          verify(await outcome(win, targetFrame), challenge, true);
        } else if (name === 'wrong-rp') {
          assert.equal((await outcome(win)).name, 'SecurityError');
          assert.equal(binding.stats().configured, 0);
        } else if (['destroy', 'navigate', 'iframe-remove'].includes(name)) {
          await until(
            () => events.some((e) => e.state === 'ended'),
            'Missing terminal notification after frame teardown'
          );
        } else if (name === 'sync-cancel' || name === 'handler-throw') {
          assert.equal((await outcome(win)).name, 'NotAllowedError');
        } else {
          await until(() => cancel, 'No owned native callback');
          if (name.startsWith('handler-')) {
            await pause();
            assert.ok(binding.stats().live > 0, 'Ignored return keeps native discovery alive');
            assert.ok(!events.some((event) => event.state === 'ended'));
            assert.equal(
              await win.webContents.executeJavaScript('globalThis.outcome'),
              null,
              'Return values do not cancel'
            );
          }
          if (name === 'ble-loss-cancel') {
            binding.setPowered(false);
            assert.equal(events.at(-1).state, 'unavailable');
          }
          if (name === 'ble-recovery') {
            assert.equal(events.at(-1).state, 'unavailable');
            binding.setPowered(true);
            assert.equal(events.at(-1).state, 'ready');
          }
          if (name === 'owner-replaced') {
            owner(() => {
              errors.push(new Error('Replacement stole active request'));
            });
          }
          if (name === 'owner-removed') owner(null);
          if (name === 'page-abort') await win.webContents.executeJavaScript('controller.abort()');
          else {
            cancel();
            cancel();
          }
          assert.equal((await outcome(win)).name, name === 'page-abort' ? 'AbortError' : 'NotAllowedError');
        }
        await idle();
        if (
          enabled &&
          !['unowned-usb-success', 'other-session-usb-success', 'wrong-rp', 'policy-denied'].includes(name)
        ) {
          await until(() => events.some((e) => e.state === 'ended'), 'Missing terminal owner update');
          assert.equal(events.filter((e) => e.state === 'ended').length, 1);
          assert.equal(new Set(events.map((e) => e.requestId)).size, 1);
        }
        assert.equal(errors.length, 0, errors.map((e) => e.stack).join('\n'));
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
        entry.stats = binding.stats();
        entry.states = events.map((e) => e.state);
        owner(null);
        save();
      }
    }
    if (enabled) {
      const entry = { name: 'concurrent-owned-requests', ok: false };
      result.tests.push(entry);
      const left = await window(),
        right = await window();
      const requests = new Map();
      binding.prepare(true, false);
      owner((details, cancel) => {
        let request = requests.get(details.requestId);
        if (!request) {
          request = {
            cancel,
            routingId: details.frame.routingId,
            processId: details.frame.processId,
            states: []
          };
          requests.set(details.requestId, request);
        }
        request.states.push(details.state);
      });
      try {
        await start(left);
        await start(right);
        await until(
          () => requests.size === 2 && [...requests.values()].every((r) => r.states.includes('ready')),
          'Both requests must become independently owned'
        );
        const leftRequest = [...requests.values()].find(
          (r) =>
            r.routingId === left.webContents.mainFrame.routingId && r.processId === left.webContents.mainFrame.processId
        );
        const rightRequest = [...requests.values()].find(
          (r) =>
            r.routingId === right.webContents.mainFrame.routingId &&
            r.processId === right.webContents.mainFrame.processId
        );
        assert.ok(leftRequest && rightRequest && leftRequest !== rightRequest);
        leftRequest.cancel();
        leftRequest.cancel();
        assert.equal((await outcome(left)).name, 'NotAllowedError');
        assert.equal(
          await right.webContents.executeJavaScript('globalThis.outcome'),
          null,
          'Cancelling one request must not settle the other'
        );
        assert.ok(!rightRequest.states.includes('ended'));
        rightRequest.cancel();
        assert.equal((await outcome(right)).name, 'NotAllowedError');
        await idle();
        await until(
          () => [...requests.values()].every((r) => r.states.includes('ended')),
          'Both requests need terminal notifications'
        );
        assert.ok([...requests.values()].every((r) => r.states.filter((state) => state === 'ended').length === 1));
        assert.equal(binding.stats().mockFailed, false);
        entry.ok = true;
      } catch (error) {
        entry.error = error.stack || String(error);
      } finally {
        for (const win of [left, right]) {
          await win.webContents.executeJavaScript('globalThis.controller?.abort()').catch(() => {});
          win.destroy();
        }
        await idle();
        owner(null);
        save();
      }
    }
    binding.uninstall();
    assert.equal(windows.size, 0);
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => frameServer.close(resolve))
    ]);
    result.ok = result.tests.every((test) => test.ok);
    result.completed = true;
    save();
    for (const test of result.tests.filter((test) => !test.ok)) {
      console.error(test.name, test.error);
    }
    app.exit(result.ok ? 0 : 1);
  })
  .catch(fatal);
