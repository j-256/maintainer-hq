import { expect, type Page } from "./test-fixture";
import type AxeBuilder from "@axe-core/playwright";

type Incomplete = Awaited<ReturnType<AxeBuilder["analyze"]>>["incomplete"];

export async function verifyFlatContrast(page: Page, incomplete: Incomplete) {
  for (const finding of incomplete) {
    expect(finding.id).toBe("color-contrast");
    for (const node of finding.nodes) {
      expect(node.target).toHaveLength(1);
      for (const check of node.any)
        expect(["pseudoContent", "elmPartiallyObscuring"]).toContain(
          check.data?.messageKey,
        );
      const measured = await page
        .locator(node.target[0] as string)
        .evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          function rgb(color: string) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          }
          function luminance(color: number[]) {
            const [r, g, b] = color
              .slice(0, 3)
              .map((channel) => channel / 255)
              .map((channel) =>
                channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4,
              );
            return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
          }
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          let text: Node | null;
          const samples: { contrast: number; visibleRects: number }[] = [];
          while ((text = walker.nextNode())) {
            if (!text.textContent?.trim()) continue;
            const parent = text.parentElement!;
            const foreground = rgb(getComputedStyle(parent).color);
            const backgrounds: string[] = [];
            let opaqueBase = false;
            for (
              let ancestor: Element | null = parent;
              ancestor;
              ancestor = ancestor.parentElement
            ) {
              const style = getComputedStyle(ancestor);
              if (
                style.backgroundImage !== "none" ||
                Number(style.opacity) !== 1
              )
                throw new Error(
                  "Layered contrast requires separate visual review",
                );
              const sample = rgb(style.backgroundColor);
              backgrounds.push(style.backgroundColor);
              if (sample[3] === 255) {
                opaqueBase = true;
                break;
              }
            }
            if (!opaqueBase || foreground[3] !== 255)
              throw new Error("No opaque contrast pair");
            context.clearRect(0, 0, 1, 1);
            for (const color of backgrounds.reverse()) {
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
            }
            const background = [...context.getImageData(0, 0, 1, 1).data];
            const range = document.createRange();
            range.selectNodeContents(text);
            let visibleRects = 0;
            for (const rect of range.getClientRects()) {
              if (!rect.width || !rect.height) continue;
              const top = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              const passThrough =
                top?.contains(element) &&
                getComputedStyle(element).pointerEvents === "none";
              if (!top || (!element.contains(top) && !passThrough))
                throw new Error(
                  `Text is obscured or clipped: ${text.textContent} at ${rect.x},${rect.y},${rect.width},${rect.height}, covered by ${top?.tagName}.${top?.className}`,
                );
              visibleRects++;
            }
            const f = luminance(foreground),
              b = luminance(background);
            samples.push({
              contrast: (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05),
              visibleRects,
            });
          }
          return samples;
        });
      expect(measured.length).toBeGreaterThan(0);
      for (const sample of measured) {
        expect(sample.visibleRects).toBeGreaterThan(0);
        expect(sample.contrast).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
}
