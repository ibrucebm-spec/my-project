// XAUUSD trading hours (typical CFD schedule, UTC): closed from Friday 21:00
// to Sunday 22:00, plus a daily one-hour break 21:00-22:00. Brokers differ by
// up to an hour around DST changes, so treat this as an approximation.
function isGoldMarketOpen(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Sunday
  const hour = date.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 21) return false;
  if (day === 0 && hour < 22) return false;
  if (hour === 21) return false;
  return true;
}

module.exports = { isGoldMarketOpen };
