// Pulls Levante UD & Villarreal CF home fixtures from football-data.org
// and writes data/matches.json (merged with data/manual_matches.json).
//
// Requires env var FOOTBALL_DATA_API_KEY.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
if (!API_KEY) {
  console.error("Missing FOOTBALL_DATA_API_KEY environment variable.");
  process.exit(1);
}

const COMPETITIONS = [
  { code: "PD", comp: "LALIGA", required: true }, // LaLiga
  { code: "CL", comp: "UCL" }, // UEFA Champions League (not on every API plan)
];
const SEASON = "2026";

// football-data.org team name -> short key used by the page (must match
// the keys used in the LOGOS / TEAM_NAMES maps inside index.html).
const NAME_TO_KEY = {
  "Levante UD": "levante",
  "Villarreal CF": "villarreal",
  "Real Betis Balompié": "betis",
  "FC Barcelona": "barcelona",
  "Athletic Club": "athletic",
  "Sevilla FC": "sevilla",
  "Club Atlético de Madrid": "atlmadrid",
  "Atletico de Madrid": "atlmadrid",
  "Elche CF": "elche",
  "Real Racing Club de Santander": "racingsantander",
  "Real Racing Club": "racingsantander",
  "Deportivo Alavés": "alaves",
  "Valencia CF": "valencia",
  "RCD Espanyol de Barcelona": "espanyol",
  "RCD Espanyol": "espanyol",
  "Real Sociedad de Fútbol": "realsociedad",
  "Real Sociedad": "realsociedad",
  "Málaga CF": "malaga",
  "RC Deportivo La Coruña": "deportivocoruna",
  "RC Deportivo": "deportivocoruna",
  "CA Osasuna": "osasuna",
  "Rayo Vallecano de Madrid": "rayovallecano",
  "Rayo Vallecano": "rayovallecano",
  "Real Madrid CF": "realmadrid",
  "Getafe CF": "getafe",
  "RC Celta de Vigo": "celta",
  "Celta de Vigo": "celta",
};

function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// European opponents are not in NAME_TO_KEY on purpose; the slug keeps them
// identifiable and toFixture ships their display name alongside.
function keyFor(teamName) {
  return NAME_TO_KEY[teamName] || slugify(teamName);
}

async function fetchMatches(code) {
  const url = `https://api.football-data.org/v4/competitions/${code}/matches?season=${SEASON}`;
  const res = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
  if (!res.ok) {
    throw new Error(`football-data.org ${code} request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.matches ?? [];
}

function toFixture(match, comp) {
  const utc = new Date(match.utcDate);
  const date = utc.toISOString().slice(0, 10);
  const hasConfirmedTime = match.status !== "SCHEDULED" || match.utcDate.slice(11, 16) !== "00:00";
  const time = hasConfirmedTime
    ? new Intl.DateTimeFormat("es-ES", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Europe/Madrid",
      }).format(utc)
    : "TBD";

  const fixture = {
    date,
    time,
    home: keyFor(match.homeTeam.name),
    away: keyFor(match.awayTeam.name),
    comp,
  };

  // European opponents have no entry in the page's TEAM_NAMES / LOGOS maps, so
  // ship their display name and crest URL along with the fixture.
  if (!NAME_TO_KEY[match.homeTeam.name]) {
    fixture.homeName = match.homeTeam.shortName || match.homeTeam.name;
    if (match.homeTeam.crest) fixture.homeCrest = match.homeTeam.crest;
  }
  if (!NAME_TO_KEY[match.awayTeam.name]) {
    fixture.awayName = match.awayTeam.shortName || match.awayTeam.name;
    if (match.awayTeam.crest) fixture.awayCrest = match.awayTeam.crest;
  }

  if (
    match.status === "FINISHED" &&
    match.score?.fullTime?.home != null &&
    match.score?.fullTime?.away != null
  ) {
    fixture.score = `${match.score.fullTime.home}-${match.score.fullTime.away}`;
  }

  return fixture;
}

// Manual entries are typed by hand, so their date/time can drift and they never
// carry a score. Look each one up in the API feed (a given home/away pairing
// happens once per season) and refresh it with the official data.
function enrichManual(manual, entries) {
  const byPairing = new Map();
  for (const entry of entries) {
    const { match } = entry;
    byPairing.set(`${keyFor(match.homeTeam.name)}|${keyFor(match.awayTeam.name)}`, entry);
  }

  let enriched = 0;
  const result = manual.map((manualEntry) => {
    const entry = byPairing.get(`${manualEntry.home}|${manualEntry.away}`);
    if (!entry) {
      console.warn(`No API match for manual fixture ${manualEntry.home} vs ${manualEntry.away}.`);
      return manualEntry;
    }
    enriched++;
    return { ...toFixture(entry.match, entry.comp), manual: true };
  });

  return { manual: result, enriched };
}

// Levante and Villarreal home games in LaLiga, Villarreal home games in Europe.
function isWantedHomeGame(match, comp) {
  const homeKey = keyFor(match.homeTeam.name);
  if (comp === "UCL") return homeKey === "villarreal";
  return homeKey === "levante" || homeKey === "villarreal";
}

// The API is the source of truth for everything except a score it has already
// reported once. A transient feed glitch (status not back to FINISHED yet, a
// null fullTime) would otherwise silently wipe a result the page had been
// showing, so a score already on disk survives a feed that no longer has one.
async function readPrevious(outPath) {
  try {
    return JSON.parse(await readFile(outPath, "utf-8"));
  } catch {
    return [];
  }
}

// A given home/away pairing happens once per season, same key enrichManual uses.
const pairingOf = (fixture) => `${fixture.home}|${fixture.away}`;

function keepKnownScores(previous, fixtures) {
  const known = new Map();
  for (const fixture of previous) {
    if (fixture.score) known.set(pairingOf(fixture), fixture.score);
  }

  return fixtures.map((fixture) => {
    if (fixture.score) return fixture;
    const score = known.get(pairingOf(fixture));
    if (!score) return fixture;
    console.warn(
      `Feed has no score for ${fixture.home} vs ${fixture.away}; keeping ${score}.`
    );
    return { ...fixture, score };
  });
}

async function main() {
  const entries = [];
  for (const { code, comp, required } of COMPETITIONS) {
    let matches;
    try {
      matches = await fetchMatches(code);
    } catch (err) {
      // The free football-data.org tier does not cover every competition; a
      // missing extra must not stop LaLiga from updating.
      if (required) throw err;
      console.warn(`Skipping ${code}: ${err.message}`);
      continue;
    }
    for (const match of matches) entries.push({ match, comp });
    console.log(`Fetched ${matches.length} ${code} matches.`);
  }

  const fixtures = entries
    .filter(({ match, comp }) => isWantedHomeGame(match, comp))
    .map(({ match, comp }) => toFixture(match, comp));

  const manualPath = path.join(ROOT, "data", "manual_matches.json");
  let manual = [];
  try {
    manual = JSON.parse(await readFile(manualPath, "utf-8"));
  } catch {
    // no manual matches file, that's fine
  }

  const { manual: manualFixtures, enriched } = enrichManual(manual, entries);

  const sorted = [...fixtures, ...manualFixtures].sort((a, b) =>
    (a.date + (a.time === "TBD" ? "" : a.time)).localeCompare(
      b.date + (b.time === "TBD" ? "" : b.time)
    )
  );

  const outPath = path.join(ROOT, "data", "matches.json");
  const merged = keepKnownScores(await readPrevious(outPath), sorted);
  await writeFile(outPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  console.log(
    `Wrote ${fixtures.length} API fixtures + ${manual.length} manual matches ` +
      `(${enriched} refreshed from the API) to ${outPath}`
  );

  const metaPath = path.join(ROOT, "data", "meta.json");
  await writeFile(
    metaPath,
    JSON.stringify({ updated_at: new Date().toISOString() }, null, 2) + "\n",
    "utf-8"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
