// Booking rules from booking.json (repo root): config validation, Europe/London time, slots and
// availability. Pure functions, no I/O: callers pass the clock, free/busy and live bookings.

export function validateConfig(cfg) {
  return cfg;
}
