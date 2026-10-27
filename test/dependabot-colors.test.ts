import { describe, expect, it } from "vitest";
import { dependabotTimeColor } from "../src/lib/dependabot-colors";

const MINUTES = 24 * 60;
const dates = ["2026-10-26", "2026-10-27", "2026-11-01", "2027-01-01"];
function luminance(channels: number[]) {
  return channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
}
describe("daily time colors", () => {
  it.each(dates)("has no duplicate rendered RGB color among the minutes of %s", date => {
    const colors = Array.from({ length: MINUTES }, (_, minute) => dependabotTimeColor(date, minute));
    expect(new Set(colors).size).toBe(MINUTES);
    expect(colors[8 * 60]).not.toBe(colors[12 * 60]);
    for (let minute = MINUTES - 1; minute >= 0; minute--)
      expect(dependabotTimeColor(date, minute)).toBe(colors[minute]);
  });
  it("keeps every palette color readable with the rendered dark foreground", () => {
    const foreground = luminance([17, 17, 17]);
    for (const date of dates)
      for (let minute = 0; minute < MINUTES; minute++) {
        const color = dependabotTimeColor(date, minute);
        const channels = color.match(/\d+/g)!.map(Number);
        expect(channels).toHaveLength(3);
        expect(channels.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)).toBe(true);
        expect((luminance(channels) + 0.05) / (foreground + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
  });
  it("rejects invalid clock minutes instead of aliasing a valid time", () => {
    for (const minute of [-1, MINUTES, 1.5, NaN, Infinity])
      expect(() => dependabotTimeColor(dates[0]!, minute)).toThrow();
  });
});
