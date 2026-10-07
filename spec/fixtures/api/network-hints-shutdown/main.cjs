const { app, BrowserWindow, session } = require('electron');

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { setTimeout } = require('node:timers/promises');

const mode = app.commandLine.getSwitchValue('test-mode');
assert.ok(['no-hover', 'hover', 'preconnect', 'preconnect-anonymous'].includes(mode));
assert.ok(app.commandLine.getSwitchValue('user-data-dir'));
app.enableSandbox();
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Permissions-Policy': 'publickey-credentials-get=(), publickey-credentials-create=()'
  });
  res.end('<!doctype html><p id="target">Network hints shutdown test</p>');
});
app.on('before-quit', () => server.close());
app.on('window-all-closed', () => app.quit());

app
  .whenReady()
  .then(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://localhost:${server.address().port}`;
    const isolated = session.fromPartition('network-hints-shutdown');
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    const win = new BrowserWindow({
      width: 600,
      height: 400,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    await win.loadURL(origin);
    win.webContents.debugger.attach('1.3');
    if (mode === 'hover') {
      win.focus();
      win.webContents.focus();
      await win.webContents.executeJavaScript(`
      window.mouseMoved = false;
      document.addEventListener('mousemove', () => { window.mouseMoved = true; });
      true;
    `);
      // Hovering an ordinary HTTP element lazily binds NetworkHintsHandler,
      // even when it is not a link and there is no DNS request to perform.
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 20,
        y: 20
      });
      assert.equal(await win.webContents.executeJavaScript('window.mouseMoved'), true);
    } else if (mode === 'preconnect' || mode === 'preconnect-anonymous') {
      const anonymous = mode === 'preconnect-anonymous';
      const received = once(isolated, 'preconnect');
      await win.webContents.executeJavaScript(`
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = ${JSON.stringify(origin)};
      if (${anonymous}) link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
      true;
    `);
      const [, url, allowCredentials, frame] = await received;
      assert.equal(url, origin + '/');
      assert.equal(allowCredentials, !anonymous);
      assert.equal(frame, win.webContents.mainFrame);
    }
    // Let the browser receive the lazily bound interface before starting quit.
    await setTimeout(100);
    win.webContents.debugger.detach();
    process.stdout.write(`network-hints-ready:${mode}\n`);
    win.close();
  })
  .catch(() => {
    process.stderr.write('Network hints shutdown fixture failed\n');
    app.exit(1);
  });
