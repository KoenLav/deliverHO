import type { IsoDateTime } from '../domain/types.js'

/**
 * Local-hour resolution for a named timezone.
 *
 * Done via Intl rather than a fixed +1/+2 offset because worker boundaries like
 * "no bookings starting after 23:00" must not silently shift by an hour twice a
 * year. A DST bug here means someone gets sent to a booking they had ruled out.
 */
export function localHourIn(timeZone: string): (at: IsoDateTime) => number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  })
  return (at: IsoDateTime) => {
    const parts = formatter.formatToParts(new Date(at))
    const hour = parts.find((p) => p.type === 'hour')?.value
    return hour === undefined ? Number.NaN : Number.parseInt(hour, 10) % 24
  }
}

export const localHourNL = localHourIn('Europe/Amsterdam')
