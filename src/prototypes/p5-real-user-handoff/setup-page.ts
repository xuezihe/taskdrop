/**
 * PROTOTYPE - THROW AWAY.
 *
 * Static Setup Page. Space Keys exist only inside the browser tab and copied
 * client configuration; the page has no network-capable JavaScript.
 */

export function createSetupPage(endpoint: string): string {
  const encodedEndpoint = JSON.stringify(endpoint);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TaskDrop P5 Local Setup</title>
  <style>
    :root { color-scheme: light; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; color: #17202a; background: #f7f6f1; }
    h1, h2 { font-family: ui-sans-serif, system-ui, sans-serif; }
    .notice { border: 2px solid #17202a; background: #fff; padding: 16px; }
    .step { margin-top: 28px; padding-top: 20px; border-top: 1px solid #9aa0a6; }
    button { font: inherit; padding: 10px 14px; border: 1px solid #17202a; background: #17202a; color: #fff; cursor: pointer; }
    button.secondary { background: #fff; color: #17202a; }
    code, pre { background: #fff; }
    pre { padding: 14px; border: 1px solid #c6c8ca; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .secret { color: #8b1e1e; }
    .muted { color: #59636e; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <h1>TaskDrop P5 — Local Setup</h1>
  <p class="notice"><strong>Prototype / throw away.</strong> This page configures one localhost-only, memory-only acceptance run. Closing the Server destroys every Handoff.</p>

  <section class="step">
    <h2>1. Generate a Space Key locally</h2>
    <p>Uses <code>crypto.getRandomValues</code> for 32 random bytes. The page does not use fetch, storage, cookies, analytics, or URL parameters.</p>
    <div class="actions">
      <button id="generate" type="button">Generate disposable Space Key</button>
      <button id="clear" class="secondary" type="button">Clear page memory</button>
    </div>
    <pre id="key" class="secret">No key generated.</pre>
  </section>

  <section id="configs" class="step" hidden>
    <h2>2. Install the MCP connection</h2>
    <p class="muted">MCP connection setup grants access to tools. It does not teach the client how to package a high-fidelity Handoff.</p>
    <button class="secondary copy" type="button" data-copy="key">Copy Space Key</button>

    <h3>Devin Desktop custom server object</h3>
    <pre id="devin-config"></pre>
    <button class="secondary copy" type="button" data-copy="devin-config">Copy Devin config</button>

    <h3>Codex shell + CLI</h3>
    <pre id="codex-config"></pre>
    <button class="secondary copy" type="button" data-copy="codex-config">Copy Codex commands</button>
  </section>

  <section class="step">
    <h2>3. Install the Handoff skill separately</h2>
    <p>MCP provides <code>create_handoff</code>, <code>get_handoff</code>, and <code>append_revision</code>. The Handoff skill defines what context belongs in Markdown.</p>
    <pre>skills/taskdrop/SKILL.md</pre>
    <p class="muted">Run both clients in this repository and explicitly ask them to read this file if they do not auto-discover project skills. Never paste the Space Key into the skill or Handoff Markdown.</p>
  </section>

  <section class="step">
    <h2>4. Run the manual acceptance stages</h2>
    <pre>d  Devin readiness
s  Devin creates the realistic source Handoff
c  Codex reads latest and appends a Revision
r  Devin reads the new latest
q  Stop Server and destroy in-memory state</pre>
    <p>Type each letter followed by Return in the terminal running P5.</p>
  </section>

  <script>
    const endpoint = ${encodedEndpoint};
    let spaceKey = "";

    const encodeBase64Url = (bytes) => {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    };

    const render = () => {
      document.querySelector("#key").textContent = spaceKey || "No key generated.";
      document.querySelector("#configs").hidden = !spaceKey;
      if (!spaceKey) return;

      document.querySelector("#devin-config").textContent = JSON.stringify({
        name: "taskdrop-p5",
        transport: "HTTP",
        serverUrl: endpoint,
        auth_method: "auth_header",
        headers: { Authorization: "Bearer " + spaceKey }
      }, null, 2);

      document.querySelector("#codex-config").textContent = [
        "read -s TASKDROP_P5_SPACE_KEY",
        "echo",
        "export TASKDROP_P5_SPACE_KEY",
        "codex mcp add taskdrop-p5 --url " + endpoint + " --bearer-token-env-var TASKDROP_P5_SPACE_KEY"
      ].join(" && ");
    };

    document.querySelector("#generate").addEventListener("click", () => {
      spaceKey = "tdp_" + encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      render();
    });

    document.querySelector("#clear").addEventListener("click", () => {
      spaceKey = "";
      render();
    });

    for (const button of document.querySelectorAll(".copy")) {
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copy);
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = "Copied";
      });
    }
  </script>
</body>
</html>`;
}
