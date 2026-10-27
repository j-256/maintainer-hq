import { DEPENDABOT_TIME } from "../../shared/dependabot";

const PALETTE = Object.freeze({
  CHANNEL_BITS: 7,
  CHANNEL_BASE: 128,
  CHANNEL_MASK: 127,
  COLOR_MASK: (1 << 21) - 1,
  MULTIPLIER: 0x9e3779,
  DATE_HASH_OFFSET: 0x811c9dc5,
  DATE_HASH_PRIME: 0x01000193,
});
export function dependabotTimeColor(date: string, minute: number): string {
  if (!Number.isInteger(minute) || minute < 0 || minute >= DEPENDABOT_TIME.MINUTES_PER_DAY)
    throw new RangeError("Choose a valid minute of the day");
  let day: number = PALETTE.DATE_HASH_OFFSET;
  for (let index = 0; index < date.length; index++)
    day = Math.imul(day ^ date.charCodeAt(index), PALETTE.DATE_HASH_PRIME);
  // An odd multiplier permutes the 21-bit space without collisions after RGB encoding
  const packed = (Math.imul(minute, PALETTE.MULTIPLIER) + day) & PALETTE.COLOR_MASK;
  const channel = (shift: number) =>
    PALETTE.CHANNEL_BASE + ((packed >>> shift) & PALETTE.CHANNEL_MASK);
  return `rgb(${channel(PALETTE.CHANNEL_BITS * 2)} ${channel(PALETTE.CHANNEL_BITS)} ${channel(0)})`;
}
