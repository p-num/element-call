// Exercise real built Call screens with a local, deliberately unavailable server.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";
const root = resolve(process.argv[2] || "dist");
const output = "test-results/letro-branding";
await mkdir(output, { recursive: true });
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const path = resolve(
    root,
    "." + (pathname === "/" ? "/index.html" : pathname),
  );
  if (!path.startsWith(root + "/")) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.setHeader(
      "Content-Type",
      mime[extname(path)] || "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(
  process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {},
);
try {
  for (const brand of ["letro", "element"])
    for (const theme of [
      "light",
      "dark",
      "light-high-contrast",
      "dark-high-contrast",
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1200, height: 800 },
      });
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        console.error(`${brand}/${theme}: ${error.message}`),
      );
      await page.route("**/config.json", (route) =>
        route.fulfill({
          json: {
            default_server_config: {
              "m.homeserver": {
                base_url: "https://matrix.example.com",
                server_name: "matrix.example.com",
              },
            },
          },
        }),
      );
      await page.route("https://matrix.example.com/**", (route) => {
        const data = route.request().postDataJSON();
        return data?.username
          ? route.fulfill({
              status: 403,
              json: {
                errcode: "M_FORBIDDEN",
                error: "Registration unavailable for theme test",
              },
            })
          : route.fulfill({ json: {} });
      });
      // Omit the brand entirely to test the default Element path.
      await page.goto(
        `${url}/#?theme=${theme}${brand === "letro" ? "&brand=letro" : ""}`,
      );
      await page.getByTestId("home_callName").waitFor();
      assert.equal(
        await page.locator("body").getAttribute("data-call-brand"),
        brand,
      );
      const accent = await page
        .locator("body")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--call-accent").trim(),
        );
      assert.equal(Boolean(accent), brand === "letro");
      await page.getByTestId("home_callName").fill("Theme preview");
      await page.getByTestId("home_displayName").fill("Preview participant");
      await page.getByTestId("home_go").focus();
      await page.screenshot({ path: `${output}/${brand}-${theme}-start.png` });
      await page.getByTestId("home_go").click();
      await page
        .getByText("Registration unavailable for theme test", { exact: false })
        .waitFor();
      await page.screenshot({ path: `${output}/${brand}-${theme}-error.png` });
      await page.reload();
      await page.getByTestId("home_callName").waitFor();
      assert.equal(
        await page.locator("body").getAttribute("data-call-brand"),
        brand,
      );
      console.log(
        `${brand}/${theme}: built screen, focus, error and reload passed`,
      );
      await context.close();
    }
} finally {
  await browser.close();
  server.close();
}
