/**
 * date - Display the current date and time
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs, envGet } from "../../utils/bytes.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const dateHelp = {
  name: "date",
  summary: "display the current time in the given FORMAT",
  usage: "date [OPTION]... [+FORMAT]",
  options: [
    "-d, --date=STRING        display time described by STRING",
    "-u, --utc                print Coordinated Universal Time (UTC)",
    "    --timezone=TZ        use the named IANA time zone (e.g. America/New_York)",
    "-I, --iso-8601           output date/time in ISO 8601 format",
    "-R, --rfc-email          output RFC 5322 date format",
    "    --help               display this help and exit",
    "",
    "If --timezone is not given, the TZ environment variable is used.",
  ],
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface DateFields {
  Y: number;
  m: number;
  D: number;
  H: number;
  M: number;
  S: number;
  w: number;
}

/**
 * Extract calendar fields for `d` as observed in IANA zone `timeZone`.
 * `timeZone` undefined means use the host's local zone.
 */
function getZonedFields(d: Date, timeZone: string | undefined): DateFields {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
  let H = Number.parseInt(parts.hour, 10);
  if (H === 24) H = 0; // some ICU builds emit "24" for midnight
  return {
    Y: Number.parseInt(parts.year, 10),
    m: Number.parseInt(parts.month, 10) - 1,
    D: Number.parseInt(parts.day, 10),
    H,
    M: Number.parseInt(parts.minute, 10),
    S: Number.parseInt(parts.second, 10),
    w: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Offset from UTC, in minutes, for `d` in `timeZone` (undefined = host local). */
function getZonedOffsetMinutes(d: Date, timeZone: string | undefined): number {
  const g = getZonedFields(d, timeZone);
  const asUTC = Date.UTC(g.Y, g.m, g.D, g.H, g.M, g.S);
  return Math.round((asUTC - d.getTime()) / 60000);
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function getTimeZoneNamePart(
  d: Date,
  timeZone: string | undefined,
  kind: "short" | "long",
): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: kind,
  });
  for (const p of dtf.formatToParts(d)) {
    if (p.type === "timeZoneName") return p.value;
  }
  return "";
}

/**
 * Short timezone name (e.g. "CEST", "PST", "UTC") for `d` in `timeZone`.
 *
 * Node's Intl returns offset-style names ("GMT+2") for many zones in `short`
 * mode, which doesn't match GNU `date`. Fall back to abbreviating the long
 * form (e.g. "Central European Summer Time" -> "CEST").
 */
function getZonedShortName(d: Date, timeZone: string | undefined): string {
  const short = getTimeZoneNamePart(d, timeZone, "short");
  // Real abbreviations don't start with "GMT" or "UTC" followed by an offset.
  if (short && !/^(GMT|UTC)[+-]/.test(short)) return short;
  const long = getTimeZoneNamePart(d, timeZone, "long");
  if (!long) return short || timeZone || "";
  if (/^Coordinated Universal Time$/i.test(long)) return "UTC";
  const initials = long.match(/\b[A-Z]/g);
  return initials ? initials.join("") : short;
}

function dayOfYear(Y: number, m: number, D: number): number {
  const start = Date.UTC(Y, 0, 1);
  const cur = Date.UTC(Y, m, D);
  return Math.round((cur - start) / 86400000) + 1;
}

function formatDate(
  d: Date,
  fmt: string,
  timeZone: string | undefined,
): string {
  const g = getZonedFields(d, timeZone);
  const offsetMin = getZonedOffsetMinutes(d, timeZone);

  let r = "",
    i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const s = fmt[++i];
      switch (s) {
        case "%":
          r += "%";
          break;
        case "a":
          r += DAYS[g.w];
          break;
        case "A":
          r += DAYS_FULL[g.w];
          break;
        case "b":
        case "h":
          r += MONTHS[g.m];
          break;
        case "B":
          r += MONTHS_FULL[g.m];
          break;
        case "C":
          r += pad(Math.floor(g.Y / 100));
          break;
        case "d":
          r += pad(g.D);
          break;
        case "D":
          r += `${pad(g.m + 1)}/${pad(g.D)}/${pad(g.Y % 100)}`;
          break;
        case "e":
          r += String(g.D).padStart(2, " ");
          break;
        case "F":
          r += `${g.Y}-${pad(g.m + 1)}-${pad(g.D)}`;
          break;
        case "H":
          r += pad(g.H);
          break;
        case "I":
          r += pad(g.H % 12 || 12);
          break;
        case "j":
          r += pad(dayOfYear(g.Y, g.m, g.D), 3);
          break;
        case "k":
          r += String(g.H).padStart(2, " ");
          break;
        case "l":
          r += String(g.H % 12 || 12).padStart(2, " ");
          break;
        case "m":
          r += pad(g.m + 1);
          break;
        case "M":
          r += pad(g.M);
          break;
        case "n":
          r += "\n";
          break;
        case "p":
          r += g.H < 12 ? "AM" : "PM";
          break;
        case "P":
          r += g.H < 12 ? "am" : "pm";
          break;
        case "R":
          r += `${pad(g.H)}:${pad(g.M)}`;
          break;
        case "s":
          r += Math.floor(d.getTime() / 1000);
          break;
        case "S":
          r += pad(g.S);
          break;
        case "t":
          r += "\t";
          break;
        case "T":
          r += `${pad(g.H)}:${pad(g.M)}:${pad(g.S)}`;
          break;
        case "u":
          r += g.w || 7;
          break;
        case "w":
          r += g.w;
          break;
        case "y":
          r += pad(g.Y % 100);
          break;
        case "Y":
          r += g.Y;
          break;
        case "z":
          r += formatOffset(offsetMin);
          break;
        case "Z":
          r += getZonedShortName(d, timeZone);
          break;
        default:
          r += `%${s}`;
      }
    } else {
      r += fmt[i];
    }
    i++;
  }
  return r;
}

/**
 * Detect whether `s` contains an explicit UTC offset that pins it to a real
 * instant (e.g. trailing `Z`, `+HH:MM`, `-HHMM`, or a named like ` UTC`).
 */
function hasExplicitOffset(s: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2}|\s(UTC|GMT))$/i.test(s.trim());
}

/**
 * Parse a wall-clock timestamp (no offset) as if its fields were observed in
 * `zone`. Returns the corresponding UTC instant, accounting for the zone's
 * offset at that moment (including DST transitions).
 */
function parseWallClockInZone(s: string, zone: string): Date | null {
  // Force JS to parse the wall-clock fields as UTC so they're host-independent.
  let isoish: string;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    isoish = `${s.replace(" ", "T")}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    isoish = `${s}T00:00:00Z`;
  } else {
    // Fall back: append " UTC" — works for many parseable forms.
    isoish = `${s} UTC`;
  }
  const utcWall = new Date(isoish);
  if (Number.isNaN(utcWall.getTime())) return null;

  // utcWall.getTime() is the wall-clock interpreted as if UTC.
  // True instant = wall_as_utc - offset_in_zone_at_that_instant.
  const off1 = getZonedOffsetMinutes(utcWall, zone);
  let instant = utcWall.getTime() - off1 * 60000;
  // DST refinement: if the offset at the candidate differs, re-shift once.
  const off2 = getZonedOffsetMinutes(new Date(instant), zone);
  if (off2 !== off1) instant = utcWall.getTime() - off2 * 60000;
  return new Date(instant);
}

/**
 * Parse a date string. `inputZone` is the IANA zone used to interpret
 * timestamps that lack an explicit offset (matches GNU `date`, which uses
 * `$TZ` for that purpose). The string may begin with an embedded
 * `TZ="ZONE"` clause that overrides `inputZone` for parsing only.
 */
function parseDate(s: string, inputZone: string | undefined): Date | null {
  // Strip leading `TZ="zone"` / `TZ='zone'` / `TZ=zone` — GNU `date` honors this
  // inside `-d` to set the input zone independently from the output zone.
  let zone = inputZone;
  const m = s.match(/^\s*TZ=(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/);
  if (m) {
    zone = m[1] ?? m[2] ?? m[3];
    s = m[4];
  }

  const l = s.toLowerCase().trim();
  if (l === "now" || l === "today") return new Date();
  if (l === "yesterday") return new Date(Date.now() - 86400000);
  if (l === "tomorrow") return new Date(Date.now() + 86400000);

  if (/^@?\d+$/.test(s)) {
    const n = Number.parseInt(s.replace(/^@/, ""), 10);
    return new Date(n * 1000);
  }

  // Explicit offset (Z, ±HH:MM, " UTC", etc.) pins the instant — use as-is.
  if (hasExplicitOffset(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Bare wall-clock: interpret in `zone` if we have one, else host local
  // (matches GNU's "use $TZ for parsing" semantics).
  if (zone !== undefined) {
    const d = parseWallClockInZone(s, zone);
    if (d) return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const dateCommand: Command = {
  name: "date",
  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) return showHelp(dateHelp);

    let utc = false,
      dateStr: string | null = null,
      fmt: string | null = null,
      iso = false,
      rfc = false,
      tzFlag: string | null = null;

    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      if (arg === "-u" || arg === "--utc") utc = true;
      else if (arg === "-d" || arg === "--date") dateStr = a[++i] ?? "";
      else if (arg.startsWith("--date=")) dateStr = arg.slice(7);
      else if (arg === "--timezone") tzFlag = a[++i] ?? "";
      else if (arg.startsWith("--timezone=")) tzFlag = arg.slice(11);
      else if (arg === "-I" || arg === "--iso-8601") iso = true;
      else if (arg === "-R" || arg === "--rfc-email") rfc = true;
      else if (arg.startsWith("+")) fmt = arg.slice(1);
      else if (arg.startsWith("--")) return unknownOption("date", arg);
      else if (arg.startsWith("-")) {
        for (const c of arg.slice(1)) {
          if (c === "u") utc = true;
          else if (c === "I") iso = true;
          else if (c === "R") rfc = true;
          else return unknownOption("date", `-${c}`);
        }
      }
    }

    // Resolve timezone: --utc wins, then --timezone, then $TZ, then host local.
    let timeZone: string | undefined;
    if (utc) {
      timeZone = "UTC";
    } else if (tzFlag !== null && tzFlag !== "") {
      timeZone = tzFlag;
    } else {
      const tzEnv = envGet(ctx.env, "TZ");
      if (tzEnv) timeZone = tzEnv;
    }

    // Validate the zone — Intl throws RangeError on unknown IANA names.
    if (timeZone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone });
      } catch {
        return {
          stdout: emptyStream(),
          stderr: fromString(`date: invalid time zone '${timeZone}'\n`),
          exitCode: 1,
        };
      }
    }

    const date = dateStr !== null ? parseDate(dateStr, timeZone) : new Date();
    if (!date)
      return {
        stdout: emptyStream(),
        stderr: fromString(`date: invalid date '${dateStr}'\n`),
        exitCode: 1,
      };

    let out: string;
    if (fmt) out = formatDate(date, fmt, timeZone);
    else if (iso) out = formatDate(date, "%Y-%m-%dT%H:%M:%S%z", timeZone);
    else if (rfc) out = formatDate(date, "%a, %d %b %Y %H:%M:%S %z", timeZone);
    else out = formatDate(date, "%a %b %e %H:%M:%S %Z %Y", timeZone);

    return {
      stdout: fromString(`${out}\n`),
      stderr: emptyStream(),
      exitCode: 0,
    };
  },
};

import { emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "date",
  flags: [
    { flag: "-d", type: "value", valueHint: "string" },
    { flag: "-u", type: "boolean" },
    { flag: "-I", type: "boolean" },
    { flag: "-R", type: "boolean" },
    { flag: "--timezone", type: "value", valueHint: "string" },
  ],
};
