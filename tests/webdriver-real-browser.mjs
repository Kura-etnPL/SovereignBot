import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarComputerDriver } from "../src/sidecar-computer-driver.js";

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SovereignBot E2E</title></head>
<body>
  <label>User <input id="user" autocomplete="off"></label>
  <label>Password <input id="password" type="password" autocomplete="off"></label>
  <button id="login">Sign in</button>
  <div id="status" role="status">waiting</div>
  <script>
    document.getElementById('login').addEventListener('click', () => {
      const user = document.getElementById('user').value;
      const password = document.getElementById('password').value;
      document.getElementById('status').textContent = user === 'alice' && password === 'real-secret' ? 'signed-in' : 'denied';
    });
  </script>
</body>
</html>`;

async function testSite() {
    const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(HTML);
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

const site = await testSite();
const root = await mkdtemp(join(tmpdir(), "sovereign-real-browser-"));
const driver = new SidecarComputerDriver({
    agentId: "real-browser",
    profileDir: join(root, "profile"),
    workspaceDir: join(root, "workspace"),
}, {
    browser: "chrome",
    headless: true,
    allowPrivateHosts: true,
    startupTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
});

try {
    const health = await driver.health();
    assert.equal(health.ok, true);
    assert.equal(health.browser, "chrome");

    await driver.navigate(site.url);
    const snapshot = await driver.snapshot();
    const user = snapshot.elements.find((element) => element.name === "User");
    const password = snapshot.elements.find((element) => element.name === "Password");
    const signIn = snapshot.elements.find((element) => element.name === "Sign in");
    assert.ok(user, "structured snapshot did not expose the labelled user field");
    assert.ok(password, "structured snapshot did not expose the labelled password field");
    assert.ok(signIn, "structured snapshot did not expose the sign-in button");

    await driver.type({ element: user, text: "alice" });
    await driver.typeSecret({ element: password, text: "real-secret" });
    await driver.click({ element: signIn });

    const after = await driver.snapshot();
    assert.ok(after.elements.some((element) => element.role === "status" && element.name === "signed-in"));

    const oldElement = signIn;
    await driver.reset();
    await assert.rejects(() => driver.click({ element: oldElement }), /browser lease changed/);

    process.stdout.write("real WebDriver sidecar E2E passed\n");
}
finally {
    await driver.close();
    await site.close();
}
