import { expect, test } from "@playwright/test";
import { OG_PAGES } from "../src/lib/og.ts";

test("each page exposes its title and shared Open Graph metadata", async ({
  page,
}) => {
  for (const config of OG_PAGES) {
    await page.goto(config.path);

    await expect(page).toHaveTitle(config.title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      config.description,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      config.title,
    );
    await expect(
      page.locator('meta[property="og:description"]'),
    ).toHaveAttribute("content", config.description);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      "https://pact.splits.org/og/pact.png",
    );
  }
});

test("the shared Open Graph image is a 1200 by 630 PNG", async ({ page }) => {
  await page.goto("/");

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<{ width: number; height: number }>((resolve, reject) => {
            const image = new Image();
            image.onload = () =>
              resolve({
                width: image.naturalWidth,
                height: image.naturalHeight,
              });
            image.onerror = () =>
              reject(new Error("Open Graph image failed to load"));
            image.src = "/og/pact.png";
          }),
      ),
    )
    .toEqual({ width: 1200, height: 630 });
});
