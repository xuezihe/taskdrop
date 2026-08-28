import { describe, expect, it } from "vitest";

import viteConfig from "../web/vite.config.js";
import {
  DEFAULT_BROWSER_API_PROXY_TARGET,
  resolveBrowserApiProxyTarget,
} from "../web/vite-proxy.js";

describe("local Web development proxy", () => {
  it("keeps Browser API calls same-origin and forwards /api to the runtime", () => {
    expect(viteConfig).toMatchObject({
      server: {
        proxy: {
          "/api": {
            target: "http://127.0.0.1:3000",
            changeOrigin: false,
          },
        },
      },
    });
  });

  it("parses and validates the Browser API proxy target at the environment boundary", () => {
    expect(resolveBrowserApiProxyTarget({})).toBe(DEFAULT_BROWSER_API_PROXY_TARGET);
    expect(
      resolveBrowserApiProxyTarget({ TASKDROP_BROWSER_API_TARGET: "https://api.example.test/" }),
    ).toBe("https://api.example.test");
    expect(() =>
      resolveBrowserApiProxyTarget({ TASKDROP_BROWSER_API_TARGET: "not a URL" }),
    ).toThrow("invalid TASKDROP_BROWSER_API_TARGET");
    expect(() =>
      resolveBrowserApiProxyTarget({ TASKDROP_BROWSER_API_TARGET: "https://api.example.test/api" }),
    ).toThrow("invalid TASKDROP_BROWSER_API_TARGET");
  });
});
