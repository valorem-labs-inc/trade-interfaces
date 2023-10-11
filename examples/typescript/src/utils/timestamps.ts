import { ONE_DAY_UNIX, ONE_WEEK_UNIX } from '../lib/constants.js';

/**
 * By aligning to 8AM UTC, we limit fragmentation of liquidity
 *
 * @returns {number} timestamp: tomorrow at 8AM UTC, represented in seconds
 */
function getTomorrowAt8AMUTC() {
  const tomorrow = new Date(Date.now() + ONE_DAY_UNIX * 1000);
  // Convert tomorrow's date to its UTC equivalent. This is achieved by adjusting
  // the local date with the timezone offset in milliseconds.
  const tzOffsetMS = tomorrow.getTimezoneOffset() * 60000;
  const utcDateMilliseconds = tomorrow.getTime() + tzOffsetMS;

  // Create a new Date object from the UTC milliseconds.
  const utcDate = new Date(utcDateMilliseconds);

  // Set the UTC time to 8:00:00 AM.
  utcDate.setUTCHours(8, 0, 0, 0);

  // Convert the UTC date to a unix timestamp and return it.
  return utcDate.getTime() / 1000;
}

export function getTimestamps(): {
  exerciseTimestamp: number;
  expiryTimestamp: number;
} {
  const exerciseTimestamp = getTomorrowAt8AMUTC();
  const expiryTimestamp = exerciseTimestamp + ONE_WEEK_UNIX; // expires in 1 week

  return { exerciseTimestamp, expiryTimestamp };
}
