// Splits events.json into upcoming and past lists at build time.
// Sorting lives here rather than in the template so events.njk stays simple
// and events.json stays hand-editable in any order.
const events = require("./events.json");

module.exports = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // An event counts as "upcoming" through the end of its last day.
  const endOf = (e) => new Date(`${e.endDate || e.startDate}T23:59:59`);

  const valid = events.filter((e) => e && e.name && e.startDate);

  return {
    upcoming: valid
      .filter((e) => endOf(e) >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    past: valid
      .filter((e) => endOf(e) < today)
      .sort((a, b) => b.startDate.localeCompare(a.startDate)),
  };
};
