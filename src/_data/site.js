// Site-wide values available in every template as `site.*`.
// Global data files like this one are evaluated once per build, so `buildYear`
// reflects the date Cloudflare Pages ran the build (see caveat in base.njk's
// footer / the site upgrade brief: the year only updates on the next commit).
module.exports = {
  name: "Victory Sparkle Co.",
  url: "https://victorysparkle.com",
  // Fallback <meta name="description"> for any page that doesn't set its own.
  description:
    "Free browser-based tools for makers, plus craft projects, coding experiments, and a running list of useful web resources.",
  // Fallback social share image. 1200x630.
  defaultOgImage: "/images/og-default.png",
  author: "Princess Sandy",
  buildYear: new Date().getFullYear(),
  // Controls what timezone blog post timestamps are displayed in (an IANA
  // zone name, e.g. "America/New_York", "America/Los_Angeles", "Europe/London").
  // Posts are always stored in UTC in D1 -- this only changes how they're
  // formatted on the page. Edit it here on GitHub and commit; no code changes needed.
  blogTimezone: "America/New_York",
};
