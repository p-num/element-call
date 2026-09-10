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
    "." + (pathname === "/" || !extname(pathname) ? "/index.html" : pathname),
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
      await page
        .getByTestId("home_callName")
        .waitFor()
        .catch(async (error) => {
          console.error(await page.locator("body").innerText());
          await page.waitForTimeout(500); // Let form/color transitions settle for review.
          await page.screenshot({
            path: `${output}/${brand}-${theme}-failure.png`,
          });
          throw error;
        });
      assert.equal(
        await page.locator("body").getAttribute("data-call-brand"),
        brand,
      );
      assert.match(
        await page.title(),
        brand === "letro" ? /^Letro(?: \||$)/ : /^Element Call(?: \||$)/,
      );
      const accent = await page
        .locator("body")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--call-accent").trim(),
        );
      assert.equal(Boolean(accent), brand === "letro");
      // Render the shipped grid CSS with a speaking state, without a live account.
      const tile = await page.evaluateHandle(() => {
        const rules = [...document.styleSheets].flatMap((sheet) => [
          ...sheet.cssRules,
        ]);
        const rule = rules.find((rule) =>
          rule.style?.background.includes("--call-grid-speaking-gradient"),
        );
        if (!rule) throw new Error("Missing shipped speaking tile CSS");
        const element = document.createElement("div");
        element.className = rule.selectorText
          .replace("::before", "")
          .split(".")
          .filter(Boolean)
          .join(" ");
        element.style.cssText =
          "position:fixed;left:40px;top:180px;width:200px;height:120px;isolation:isolate;background:var(--cpd-color-bg-canvas-default);border-radius:16px";
        const content = document.createElement("div");
        content.style.cssText =
          "height:100%;box-sizing:border-box;padding:16px;border-radius:16px;background:var(--cpd-color-bg-canvas-default);color:var(--cpd-color-text-primary)";
        content.textContent = "Speaking participant";
        element.append(content);
        document.body.append(element);
        return element;
      });
      await page.waitForTimeout(200);
      const border = await tile.evaluate(
        (el) => getComputedStyle(el, "::before").backgroundImage,
      );
      assert.equal(border.includes("13, 92, 189"), brand === "element");
      assert.notEqual(border, "none");
      if (brand === "letro")
        assert.match(
          border,
          theme.startsWith("dark") ? /252, 206, 202/ : /126, 17, 7/,
        );
      await page.screenshot({
        clip: { x: 30, y: 170, width: 220, height: 140 },
        path: `${output}/${brand}-${theme}-speaking.png`,
        animations: "disabled",
      });
      await tile.evaluate((el) => el.remove());
      await page.getByTestId("home_callName").fill("Theme preview");
      await page.getByTestId("home_displayName").fill("Preview participant");
      await page.getByTestId("home_go").focus();
      if (brand === "letro")
        assert.equal(
          await page
            .getByTestId("home_go")
            .evaluate((el) => getComputedStyle(el).outlineStyle),
          "solid",
        );
      await page.waitForTimeout(500); // Let form/color transitions settle for review.
      await page.screenshot({
        animations: "disabled",
        path: `${output}/${brand}-${theme}-start.png`,
      });
      await page.getByTestId("home_go").click();
      await page
        .getByText("Registration unavailable for theme test", { exact: false })
        .waitFor();
      await page.waitForTimeout(500); // Let form/color transitions settle for review.
      await page.screenshot({
        animations: "disabled",
        path: `${output}/${brand}-${theme}-error.png`,
      });
      await page.reload();
      await page.getByTestId("home_callName").waitFor();
      assert.equal(
        await page.locator("body").getAttribute("data-call-brand"),
        brand,
      );
      assert.match(
        await page.title(),
        brand === "letro" ? /^Letro(?: \||$)/ : /^Element Call(?: \||$)/,
      );
      if (brand === "letro") {
        assert.match(
          await page.locator('link[rel="icon"]').getAttribute("href"),
          /letro-icon|data:image\/png/,
        );
        await page.getByRole("link", { name: "Log In", exact: true }).click();
        await page.getByText("To continue to Letro", { exact: true }).waitFor();
        await page.reload();
        await page.getByText("To continue to Letro", { exact: true }).waitFor();
        assert.equal(
          await page.locator("body").getAttribute("data-call-brand"),
          "letro",
        );
      }
      console.log(
        `${brand}/${theme}: built screen, focus, error and reload passed`,
      );
      await context.close();
    }
} finally {
  await browser.close();
  server.close();
}
