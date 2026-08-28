import { COPY, type Copy } from "./copy.js";
import { createSpaceKey } from "./generate-space-key.js";
import { parseHandoffPath } from "./handoff-route.js";
import { LANGUAGE_STORAGE_KEY, type LandingLanguage, resolveLanguage } from "./language.js";
import { bearerMcpFields, formatMcpSnippet, queryMcpFields } from "./mcp-config.js";
import { resolveMcpOrigin } from "./mcp-origin.js";
import {
  emptySession,
  sessionAfterCopy,
  sessionAfterGenerate,
  shouldWarnBeforeUnload,
} from "./session.js";

const origin = resolveMcpOrigin(
  import.meta.env.TASKDROP_MCP_ORIGIN ?? import.meta.env.VITE_TASKDROP_MCP_ORIGIN,
);
const githubUrl = "https://github.com/xuezihe/taskdrop";
const guideUrl = `${githubUrl}/blob/main/docs/taskdrop-user-guide.md`;
const clientSetupGuideUrl = `${githubUrl}/blob/main/docs/mcp-client-setup.md`;

const app = document.querySelector("#app");
if (!(app instanceof HTMLElement)) throw new Error("missing #app");
const root: HTMLElement = app;

let language = resolveLanguage(navigator.languages, localStorage.getItem(LANGUAGE_STORAGE_KEY));
let session = emptySession();
let activeConfig: "bearer" | "query" = "bearer";
let status: "idle" | "copied-key" | "copied-config" = "idle";

function copyFor(lang: LandingLanguage): Copy {
  return COPY[lang];
}

function fillBrowserEntropy(target: Uint8Array): Uint8Array {
  const entropy = new Uint8Array(target.length);
  crypto.getRandomValues(entropy);
  target.set(entropy);
  return target;
}

function bearerSnippet(spaceKey: string): string {
  return formatMcpSnippet("taskdrop", bearerMcpFields(origin, spaceKey));
}

function querySnippet(spaceKey: string): string {
  return formatMcpSnippet("taskdrop", queryMcpFields(origin, spaceKey));
}

async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!shouldWarnBeforeUnload(session)) return;
  event.preventDefault();
  event.returnValue = "";
}

function setLanguage(next: LandingLanguage): void {
  language = next;
  localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  render();
}

function generate(): void {
  session = sessionAfterGenerate(session, createSpaceKey(fillBrowserEntropy));
  status = "idle";
  render();
  requestAnimationFrame(() => {
    root.querySelector(".inject-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function copyText(kind: "key" | "config", text: string): Promise<void> {
  await writeClipboard(text);
  if (kind === "key") session = sessionAfterCopy(session);
  status = kind === "key" ? "copied-key" : "copied-config";
  render();
}

function icon(name: "arrow" | "check" | "copy" | "github" | "key" | "spark"): string {
  const paths = {
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    github:
      '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.2.5S18.1.1 15 1.8a13.4 13.4 0 0 0-7 0C4.9.1 3.8.5 3.8.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.3 3.5 6.5 6.8 6.9A4.8 4.8 0 0 0 7.5 18v4M7.5 19c-3 .9-3-1.5-4.2-2"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8-8M15 8l3 3M17 6l2 2"/>',
    spark:
      '<path d="m12 3-1.2 4.1a5.2 5.2 0 0 1-3.6 3.6L3 12l4.2 1.3a5.2 5.2 0 0 1 3.6 3.6L12 21l1.2-4.1a5.2 5.2 0 0 1 3.6-3.6L21 12l-4.2-1.3a5.2 5.2 0 0 1-3.6-3.6L12 3Z"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function render(): void {
  const t = copyFor(language);
  const key = session.spaceKey;
  const config = key
    ? activeConfig === "bearer"
      ? bearerSnippet(key)
      : querySnippet(key)
    : t.configLocked;
  const activeNote = activeConfig === "bearer" ? t.bearerNote : t.queryNote;

  document.documentElement.lang = language === "zh" ? "zh-Hans" : "en";
  document.title = t.title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", t.description);

  root.innerHTML = `
    <div class="page-shell">
      <header class="topbar wrap">
        <a class="brand" href="#top" aria-label="TaskDrop home">
          <span class="brand-mark"><span></span></span>${t.brand}
        </a>
        <nav class="nav-links" aria-label="Primary navigation">
          <a href="#how">${t.navHow}</a>
          <a href="#setup">${t.navSetup}</a>
          <a href="${githubUrl}" target="_blank" rel="noreferrer">${t.navGithub}</a>
        </nav>
        <div class="lang" role="group" aria-label="Language">
          <button type="button" data-lang="en" aria-pressed="${language === "en"}">${t.languageEn}</button>
          <button type="button" data-lang="zh" aria-pressed="${language === "zh"}">${t.languageZh}</button>
        </div>
      </header>

      <main id="top">
        <section class="hero wrap">
          <div class="hero-copy">
            <p class="eyebrow">${icon("spark")}${t.eyebrow}</p>
            <h1>${t.heroTitleStart}<br><span>${t.heroTitleAccent}</span></h1>
            <p class="hero-body">${t.heroBody}</p>
            <div class="badges" aria-label="Product properties">
              <span>${icon("check")}${t.badgeAccount}</span>
              <span>${icon("check")}${t.badgeExpiry}</span>
              <span>${icon("check")}${t.badgeSource}</span>
            </div>
          </div>

          <section class="key-tool" aria-labelledby="key-tool-title">
            <div class="tool-head">
              <div>
                <p class="section-kicker">${t.toolKicker}</p>
                <h2 id="key-tool-title">${t.toolTitle}</h2>
              </div>
              <span class="local-pill"><i></i>${t.localOnly}</span>
            </div>
            <p class="tool-body">${t.toolBody}</p>
            <div class="key-field ${key ? "has-key" : ""}">
              <span class="field-icon">${icon("key")}</span>
              <div class="key-value">
                <span>${t.keyLabel}</span>
                <code>${key ?? t.keyEmpty}</code>
              </div>
              ${key ? `<button class="icon-button" type="button" data-action="copy-key" aria-label="${t.copyKey}" title="${t.copyKey}">${status === "copied-key" ? icon("check") : icon("copy")}</button>` : ""}
            </div>
            <div class="tool-actions">
              <button type="button" class="primary" data-action="generate">
                ${key ? t.regenerate : t.generate}${icon("arrow")}
              </button>
              ${key ? `<span class="inline-status" aria-live="polite">${status === "copied-key" ? t.copied : ""}</span>` : ""}
            </div>
            <p class="security-note">${key ? t.retainNote : t.retainNote}</p>
            ${key ? `<p class="regenerate-note">${t.regenerateNote}</p>` : ""}
          </section>
        </section>

        <section class="inject-section ${key ? "is-open" : ""}" aria-live="polite">
          <hr class="divider" />
          ${
            key
              ? `<div class="inject-grid wrap">
                  <div class="inject-copy">
                    <p class="section-kicker">${t.setupKicker}</p>
                    <h2>${t.setupTitle}</h2>
                    <p>${t.setupBody}</p>
                    <div class="client-guide-cta">
                      <span>${t.clientGuidePrompt}</span>
                      <a href="${clientSetupGuideUrl}" target="_blank" rel="noreferrer">
                        ${t.clientGuideLink}${icon("arrow")}
                      </a>
                    </div>
                  </div>
                  <div class="config-card">
                    <div class="config-tabs" role="tablist" aria-label="MCP credential carrier">
                      <button type="button" role="tab" data-config="bearer" aria-selected="${activeConfig === "bearer"}">
                        ${t.bearerTab}<small>${t.bearerLabel}</small>
                      </button>
                      <button type="button" role="tab" data-config="query" aria-selected="${activeConfig === "query"}">
                        ${t.queryTab}<small>${t.queryLabel}</small>
                      </button>
                    </div>
                    <div class="config-note"><span></span>${activeNote}</div>
                    <pre class="config"><code>${config}</code></pre>
                    <button type="button" class="copy-config" data-action="copy-config">
                      ${status === "copied-config" ? icon("check") + t.copied : icon("copy") + t.copyConfig}
                    </button>
                  </div>
                </div>`
              : ""
          }
        </section>
        <section class="handoff-strip" aria-label="TaskDrop flow">
          <div class="handoff-flow wrap">
            <article>
              <span class="flow-number">01</span>
              <div><strong>${t.flowFrom}</strong><p>${t.flowFromBody}</p></div>
            </article>
            <span class="flow-arrow">${icon("arrow")}</span>
            <article class="flow-center">
              <span class="flow-number">02</span>
              <div><strong>${t.flowCode}</strong><code>K7M2Q9</code><p>${t.flowCodeBody}</p></div>
            </article>
            <span class="flow-arrow">${icon("arrow")}</span>
            <article>
              <span class="flow-number">03</span>
              <div><strong>${t.flowTo}</strong><p>${t.flowToBody}</p></div>
            </article>
          </div>
        </section>

        <section class="content-section wrap" id="how">
          <div class="section-heading">
            <p class="section-kicker">${t.howKicker}</p>
            <h2>${t.howTitle}</h2>
          </div>
          <div class="steps">
            <article><span>01</span><h3>${t.step1Title}</h3><p>${t.step1Body}</p></article>
            <article><span>02</span><h3>${t.step2Title}</h3><p>${t.step2Body}</p></article>
            <article><span>03</span><h3>${t.step3Title}</h3><p>${t.step3Body}</p></article>
          </div>
        </section>

        <section class="setup-section" id="setup">
          <div class="setup-grid wrap">
            <div class="setup-copy">
              <p class="section-kicker">${t.guideKicker}</p>
              <h2>${t.guideTitle}</h2>
              <p>${t.guideBody}</p>
              <div class="skill-card">
                <span class="skill-icon">${icon("spark")}</span>
                <div><h3>${t.nextHeading}</h3><p>${t.nextBody}</p>
                <a href="${guideUrl}" target="_blank" rel="noreferrer">${t.nextLink}${icon("arrow")}</a></div>
              </div>
            </div>
            <div class="setup-prompt" aria-hidden="true">
              <span>${icon("key")}</span>
              <code>create_handoff → K7M2Q9</code>
              <i>${icon("arrow")}</i>
              <code>load_handoff → Revision 3</code>
            </div>
          </div>
        </section>

        <section class="content-section wrap trust-section">
          <div class="section-heading">
            <p class="section-kicker">${t.trustKicker}</p>
            <h2>${t.trustTitle}</h2>
          </div>
          <div class="trust-grid">
            <article><span class="trust-icon">${icon("key")}</span><h3>${t.privacyTitle}</h3><p>${t.privacyBody}</p></article>
            <article><span class="trust-icon revision-icon">R3</span><h3>${t.revisionsTitle}</h3><p>${t.revisionsBody}</p></article>
            <article><span class="trust-icon">${icon("github")}</span><h3>${t.opensourceTitle}</h3><p>${t.opensourceBody}</p></article>
          </div>
          <details class="boundaries">
            <summary>${t.boundariesTitle}<span>+</span></summary>
            <p>${t.boundariesBody}</p>
          </details>
        </section>
      </main>

      <footer class="footer wrap">
        <a class="brand footer-brand" href="#top"><span class="brand-mark"><span></span></span>${t.brand}</a>
        <p>${t.footerTagline}</p>
        <a class="footer-link" href="${githubUrl}" target="_blank" rel="noreferrer">${icon("github")}${t.footerRepo}</a>
      </footer>
    </div>
  `;

  root.querySelector("[data-lang='en']")?.addEventListener("click", () => setLanguage("en"));
  root.querySelector("[data-lang='zh']")?.addEventListener("click", () => setLanguage("zh"));
  root.querySelector("[data-action='generate']")?.addEventListener("click", generate);
  root.querySelector("[data-action='copy-key']")?.addEventListener("click", () => {
    if (session.spaceKey) void copyText("key", session.spaceKey);
  });
  root.querySelectorAll<HTMLElement>("[data-config]").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeConfig = tab.dataset.config === "query" ? "query" : "bearer";
      status = "idle";
      render();
    });
  });
  root.querySelector("[data-action='copy-config']")?.addEventListener("click", () => {
    if (!session.spaceKey) return;
    const snippet =
      activeConfig === "bearer" ? bearerSnippet(session.spaceKey) : querySnippet(session.spaceKey);
    void copyText("config", snippet);
  });
}

const handoffCode = parseHandoffPath(window.location.pathname);
if (handoffCode) {
  void import("./handoff-workspace.js")
    .then(({ mountHandoffWorkspace }) => mountHandoffWorkspace(root, handoffCode))
    .catch(() => {
      root.textContent = "The Handoff Workspace could not be loaded.";
    });
} else {
  window.addEventListener("beforeunload", onBeforeUnload);
  render();
}
