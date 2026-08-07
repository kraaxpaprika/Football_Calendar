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

const COMPETITION = "PD"; // LaLiga
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

function keyFor(teamName) {
  if (NAME_TO_KEY[teamName]) return NAME_TO_KEY[teamName];
  console.warn(`No key mapping for team "${teamName}", falling back to slug.`);
  return slugify(teamName);
}

async function fetchMatches() {
  const url = `https://api.football-data.org/v4/competitions/${COMPETITION}/matches?season=${SEASON}`;
  const res = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
  if (!res.ok) {
    throw new Error(`football-data.org request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.matches ?? [];
}

function toFixture(match) {
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

  return {
    date,
    time,
    home: keyFor(match.homeTeam.name),
    away: keyFor(match.awayTeam.name),
    comp: "LALIGA",
  };
}

async function main() {
  const matches = await fetchMatches();

  const fixtures = matches
    .filter((m) => {
      const homeKey = keyFor(m.homeTeam.name);
      return homeKey === "levante" || homeKey === "villarreal";
    })
    .map(toFixture);

  const manualPath = path.join(ROOT, "data", "manual_matches.json");
  let manual = [];
  try {
    manual = JSON.parse(await readFile(manualPath, "utf-8"));
  } catch {
    // no manual matches file, that's fine
  }

  const merged = [...fixtures, ...manual].sort((a, b) =>
    (a.date + (a.time === "TBD" ? "" : a.time)).localeCompare(
      b.date + (b.time === "TBD" ? "" : b.time)
    )
  );

  const outPath = path.join(ROOT, "data", "matches.json");
  await writeFile(outPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${fixtures.length} API fixtures + ${manual.length} manual matches to ${outPath}`);

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
