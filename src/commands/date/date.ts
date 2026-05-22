/**
 * date - Display the current date and time
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs, envGet } from "../../utils/bytes.js";
import { emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const dateHelp = {
  name: "date",
  summary: "display the current time in the given FORMAT",
  usage: "date [OPTION]... [+FORMAT]",
  options: [
    "-d, --date=STRING        display time described by STRING",
    "-u, --utc                print Coordinated Universal Time (UTC)",
    "    --timezone=TZ        use the named IANA time zone (e.g. America/New_York)",
    "-r, --reference=FILE     display the last modification time of FILE",
    "-I, --iso-8601           output date/time in ISO 8601 format",
    "-R, --rfc-email          output RFC 5322 date format",
    "    --rfc-3339=FMT       output RFC 3339 (FMT: date | seconds | ns)",
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

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DAY_NAME_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
};

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

interface DateFields {
  Y: number;
  m: number;
  D: number;
  H: number;
  M: number;
  S: number;
  w: number;
}

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
  if (H === 24) H = 0;
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

function getZonedOffsetMinutes(d: Date, timeZone: string | undefined): number {
  const g = getZonedFields(d, timeZone);
  const asUTC = Date.UTC(g.Y, g.m, g.D, g.H, g.M, g.S);
  return Math.round((asUTC - d.getTime()) / 60000);
}

function formatOffset(minutes: number, colons: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (colons === 0) return `${sign}${pad(h)}${pad(m)}`;
  if (colons === 1) return `${sign}${pad(h)}:${pad(m)}`;
  if (colons === 2) return `${sign}${pad(h)}:${pad(m)}:00`;
  // ::: → minimal precision
  if (m === 0) return `${sign}${pad(h)}`;
  return `${sign}${pad(h)}:${pad(m)}`;
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
 * Long-name -> canonical abbreviation overrides for zones where Intl's English
 * name doesn't map to the GNU/tzdata abbreviation via initials-of-caps.
 */
const ZONE_NAME_OVERRIDES: Record<string, string> = {
  "Moscow Standard Time": "MSK",
};

function getZonedShortName(d: Date, timeZone: string | undefined): string {
  const short = getTimeZoneNamePart(d, timeZone, "short");
  if (short && !/^(GMT|UTC)[+-]/.test(short)) return short;
  let long = getTimeZoneNamePart(d, timeZone, "long");
  if (!long) return short || timeZone || "";
  if (/^Coordinated Universal Time$/i.test(long)) return "UTC";
  if (ZONE_NAME_OVERRIDES[long]) return ZONE_NAME_OVERRIDES[long];
  // GNU/tzdata drops "Standard" from European winter abbreviations:
  // "Central European Standard Time" -> CET (not CEST, which is summer).
  // Daylight/summer variants keep their qualifier.
  if (/European/.test(long)) {
    long = long.replace(/\bStandard\s+/i, "");
  }
  const initials = long.match(/\b[A-Z]/g);
  return initials ? initials.join("") : short;
}

function dayOfYear(Y: number, m: number, D: number): number {
  const start = Date.UTC(Y, 0, 1);
  const cur = Date.UTC(Y, m, D);
  return Math.round((cur - start) / 86400000) + 1;
}

/**
 * ISO 8601 week number and ISO week-year for `Y-m-D`.
 * Week 1 contains the year's first Thursday; weeks start Monday.
 */
function isoWeek(
  Y: number,
  m: number,
  D: number,
): { week: number; year: number } {
  // Work in UTC to avoid DST headaches; only date fields matter.
  const t = new Date(Date.UTC(Y, m, D));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  // Shift to the Thursday of this week — week-year is then this Thursday's year.
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { week, year };
}

type Mod = "-" | "_" | "0" | "^" | "#" | null;

function applyTextMod(text: string, mod: Mod): string {
  if (mod === "^") return text.toUpperCase();
  if (mod === "#") {
    // GNU: lowercase if all-upper, otherwise uppercase.
    return /[a-z]/.test(text) ? text.toUpperCase() : text.toLowerCase();
  }
  return text;
}

function applyNumMod(
  value: number,
  defaultWidth: number,
  defaultPad: "0" | " ",
  mod: Mod,
): string {
  const s = String(value);
  if (mod === "-") return s; // strip padding
  if (mod === "_") return s.padStart(defaultWidth, " ");
  if (mod === "0") return s.padStart(defaultWidth, "0");
  return s.padStart(defaultWidth, defaultPad);
}

function formatNanoseconds(d: Date, width: number): string {
  // JS only has ms precision. Pad to 9 digits with zeros.
  const ms = ((d.getTime() % 1000) + 1000) % 1000;
  const full = `${pad(ms, 3)}000000`;
  if (width <= 0 || width >= 9) return full;
  return full.slice(0, width);
}

function formatDate(
  d: Date,
  fmt: string,
  timeZone: string | undefined,
): string {
  const g = getZonedFields(d, timeZone);
  const offsetMin = getZonedOffsetMinutes(d, timeZone);

  let r = "";
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== "%" || i + 1 >= fmt.length) {
      r += ch;
      i++;
      continue;
    }
    i++; // consume '%'
    // Modifier.
    let mod: Mod = null;
    if ("-_0^#".includes(fmt[i] ?? "")) {
      mod = fmt[i] as Mod;
      i++;
    }
    // Optional decimal width (used by %N).
    let width = 0;
    while (i < fmt.length && /\d/.test(fmt[i])) {
      width = width * 10 + (fmt.charCodeAt(i) - 48);
      i++;
    }
    // Colons for %:z variants.
    let colons = 0;
    while (fmt[i] === ":") {
      colons++;
      i++;
    }
    const spec = fmt[i] ?? "";
    i++;

    // Unknown spec: re-emit literally including any modifier/colons/width.
    const literalize = (text: string): string => text;

    switch (spec) {
      case "%":
        r += "%";
        break;
      case "n":
        r += "\n";
        break;
      case "t":
        r += "\t";
        break;
      case "a":
        r += applyTextMod(DAYS[g.w], mod);
        break;
      case "A":
        r += applyTextMod(DAYS_FULL[g.w], mod);
        break;
      case "b":
      case "h":
        r += applyTextMod(MONTHS[g.m], mod);
        break;
      case "B":
        r += applyTextMod(MONTHS_FULL[g.m], mod);
        break;
      case "C":
        r += applyNumMod(Math.floor(g.Y / 100), 2, "0", mod);
        break;
      case "d":
        r += applyNumMod(g.D, 2, "0", mod);
        break;
      case "D":
        r += `${pad(g.m + 1)}/${pad(g.D)}/${pad(g.Y % 100)}`;
        break;
      case "e":
        r += applyNumMod(g.D, 2, " ", mod);
        break;
      case "F":
        r += `${pad(g.Y, 4)}-${pad(g.m + 1)}-${pad(g.D)}`;
        break;
      case "g": {
        const wy = isoWeek(g.Y, g.m, g.D).year % 100;
        r += applyNumMod(wy, 2, "0", mod);
        break;
      }
      case "G":
        r += applyNumMod(isoWeek(g.Y, g.m, g.D).year, 4, "0", mod);
        break;
      case "H":
        r += applyNumMod(g.H, 2, "0", mod);
        break;
      case "I":
        r += applyNumMod(g.H % 12 || 12, 2, "0", mod);
        break;
      case "j":
        r += applyNumMod(dayOfYear(g.Y, g.m, g.D), 3, "0", mod);
        break;
      case "k":
        r += applyNumMod(g.H, 2, " ", mod);
        break;
      case "l":
        r += applyNumMod(g.H % 12 || 12, 2, " ", mod);
        break;
      case "m":
        r += applyNumMod(g.m + 1, 2, "0", mod);
        break;
      case "M":
        r += applyNumMod(g.M, 2, "0", mod);
        break;
      case "N":
        r += formatNanoseconds(d, width || 9);
        break;
      case "p":
        r += applyTextMod(g.H < 12 ? "AM" : "PM", mod);
        break;
      case "P":
        r += applyTextMod(g.H < 12 ? "am" : "pm", mod);
        break;
      case "q":
        r += applyNumMod(Math.floor(g.m / 3) + 1, 1, "0", mod);
        break;
      case "r":
        r += `${pad(g.H % 12 || 12)}:${pad(g.M)}:${pad(g.S)} ${g.H < 12 ? "AM" : "PM"}`;
        break;
      case "R":
        r += `${pad(g.H)}:${pad(g.M)}`;
        break;
      case "s":
        r += String(Math.floor(d.getTime() / 1000));
        break;
      case "S":
        r += applyNumMod(g.S, 2, "0", mod);
        break;
      case "T":
      case "X":
        r += `${pad(g.H)}:${pad(g.M)}:${pad(g.S)}`;
        break;
      case "u":
        r += String(g.w || 7);
        break;
      case "V":
        r += applyNumMod(isoWeek(g.Y, g.m, g.D).week, 2, "0", mod);
        break;
      case "w":
        r += String(g.w);
        break;
      case "x":
        r += `${pad(g.m + 1)}/${pad(g.D)}/${pad(g.Y % 100)}`;
        break;
      case "y":
        r += applyNumMod(g.Y % 100, 2, "0", mod);
        break;
      case "Y":
        r += applyNumMod(g.Y, 4, "0", mod);
        break;
      case "z":
        r += formatOffset(offsetMin, colons);
        break;
      case "Z":
        r += getZonedShortName(d, timeZone);
        break;
      case "c":
        // GNU LC_ALL=C: `Fri May 22 14:31:05 2026`
        r += `${DAYS[g.w]} ${MONTHS[g.m]} ${String(g.D).padStart(2, " ")} ${pad(g.H)}:${pad(g.M)}:${pad(g.S)} ${g.Y}`;
        break;
      default: {
        // Unknown — reproduce the original sequence.
        const modStr = mod ?? "";
        const widthStr = width > 0 ? String(width) : "";
        const colonStr = ":".repeat(colons);
        r += literalize(`%${modStr}${widthStr}${colonStr}${spec}`);
        break;
      }
    }
  }
  return r;
}

function hasExplicitOffset(s: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2}|\s(UTC|GMT))$/i.test(s.trim());
}

function parseWallClockInZone(s: string, zone: string): Date | null {
  let isoish: string;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    isoish = `${s.replace(" ", "T")}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    isoish = `${s}T00:00:00Z`;
  } else {
    isoish = `${s} UTC`;
  }
  const utcWall = new Date(isoish);
  if (Number.isNaN(utcWall.getTime())) return null;

  const off1 = getZonedOffsetMinutes(utcWall, zone);
  let instant = utcWall.getTime() - off1 * 60000;
  const off2 = getZonedOffsetMinutes(new Date(instant), zone);
  if (off2 !== off1) instant = utcWall.getTime() - off2 * 60000;
  return new Date(instant);
}

function addUnits(d: Date, n: number, unit: string): Date {
  const u = unit.toLowerCase().replace(/s$/, "");
  if (u === "month") {
    const out = new Date(d.getTime());
    out.setUTCMonth(out.getUTCMonth() + n);
    return out;
  }
  if (u === "year") {
    const out = new Date(d.getTime());
    out.setUTCFullYear(out.getUTCFullYear() + n);
    return out;
  }
  const ms = UNIT_MS[u];
  if (ms === undefined) return d;
  return new Date(d.getTime() + n * ms);
}

/** Find the upcoming/previous occurrence of `targetDay` (0=Sun..6=Sat) in `zone`. */
function nextDayName(
  targetDay: number,
  qualifier: "next" | "last" | null,
  zone: string | undefined,
): Date {
  const now = new Date();
  const todayDow = getZonedFields(now, zone).w;
  let delta: number;
  if (qualifier === "next") {
    delta = (targetDay - todayDow + 7) % 7 || 7;
  } else if (qualifier === "last") {
    delta = -((todayDow - targetDay + 7) % 7 || 7);
  } else {
    delta = (targetDay - todayDow + 7) % 7;
  }
  return new Date(now.getTime() + delta * 86_400_000);
}

/** Set the wall-clock H:M:S of `base` (interpreted in `zone`) and return the new instant. */
function setTimeOfDayInZone(
  base: Date,
  H: number,
  M: number,
  S: number,
  zone: string | undefined,
): Date {
  const g = getZonedFields(base, zone);
  const wall = `${pad(g.Y, 4)}-${pad(g.m + 1)}-${pad(g.D)} ${pad(H)}:${pad(M)}:${pad(S)}`;
  if (zone) {
    const r = parseWallClockInZone(wall, zone);
    if (r) return r;
  }
  const r = new Date(wall);
  return Number.isNaN(r.getTime()) ? base : r;
}

const RE_AGO = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/;
const RE_FUTURE = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?$/;
const RE_ARITH =
  /^(.+?)\s+([+-])\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?$/i;

function parseDate(s: string, inputZone: string | undefined): Date | null {
  // Embedded TZ="zone" prefix.
  let zone = inputZone;
  const tzMatch = s.match(/^\s*TZ=(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/);
  if (tzMatch) {
    zone = tzMatch[1] ?? tzMatch[2] ?? tzMatch[3];
    s = tzMatch[4];
  }
  s = s.trim();
  const l = s.toLowerCase();

  if (l === "now" || l === "today") return new Date();
  if (l === "yesterday") return new Date(Date.now() - 86_400_000);
  if (l === "tomorrow") return new Date(Date.now() + 86_400_000);

  // Day name: "monday", "next monday", "last monday".
  const dayMatch = l.match(
    /^(next|last)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
  );
  if (dayMatch) {
    const qualifier = (dayMatch[1] as "next" | "last" | undefined) ?? null;
    return nextDayName(DAY_NAME_INDEX[dayMatch[2]], qualifier, zone);
  }

  // "N units ago"
  const agoMatch = l.match(RE_AGO);
  if (agoMatch) {
    return addUnits(new Date(), -Number.parseInt(agoMatch[1], 10), agoMatch[2]);
  }
  // "N units" (future, GNU treats bare "1 day" as future)
  const futureMatch = l.match(RE_FUTURE);
  if (futureMatch) {
    return addUnits(
      new Date(),
      Number.parseInt(futureMatch[1], 10),
      futureMatch[2],
    );
  }

  // Compound keyword + time-of-day: "yesterday 12:00", "today 09:30:15"
  const compoundMatch = l.match(
    /^(now|today|yesterday|tomorrow)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (compoundMatch) {
    const baseKw = compoundMatch[1];
    let base = new Date();
    if (baseKw === "yesterday") base = new Date(Date.now() - 86_400_000);
    else if (baseKw === "tomorrow") base = new Date(Date.now() + 86_400_000);
    return setTimeOfDayInZone(
      base,
      Number.parseInt(compoundMatch[2], 10),
      Number.parseInt(compoundMatch[3], 10),
      Number.parseInt(compoundMatch[4] ?? "0", 10),
      zone,
    );
  }

  // Arithmetic on a base: "<base> +/- N units". Recurse on the base.
  const arithMatch = s.match(RE_ARITH);
  if (arithMatch) {
    const base = parseDate(arithMatch[1], zone);
    if (!base) return null;
    const sign = arithMatch[2] === "+" ? 1 : -1;
    return addUnits(
      base,
      sign * Number.parseInt(arithMatch[3], 10),
      arithMatch[4],
    );
  }

  // @epoch or bare numeric epoch.
  if (/^@?\d+$/.test(s)) {
    const n = Number.parseInt(s.replace(/^@/, ""), 10);
    return new Date(n * 1000);
  }

  // Explicit-offset ISO strings.
  if (hasExplicitOffset(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Bare wall-clock — interpret in zone if set.
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

    let utc = false;
    let dateStr: string | null = null;
    let fmt: string | null = null;
    let iso = false;
    let rfc = false;
    let rfc3339: "date" | "seconds" | "ns" | null = null;
    let tzFlag: string | null = null;
    let refFile: string | null = null;

    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      if (arg === "-u" || arg === "--utc") utc = true;
      else if (arg === "-d" || arg === "--date") dateStr = a[++i] ?? "";
      else if (arg.startsWith("--date=")) dateStr = arg.slice(7);
      else if (arg === "--timezone") tzFlag = a[++i] ?? "";
      else if (arg.startsWith("--timezone=")) tzFlag = arg.slice(11);
      else if (arg === "-r" || arg === "--reference") refFile = a[++i] ?? "";
      else if (arg.startsWith("--reference=")) refFile = arg.slice(12);
      else if (arg === "-I" || arg === "--iso-8601") iso = true;
      else if (arg === "-R" || arg === "--rfc-email") rfc = true;
      else if (arg.startsWith("--rfc-3339=")) {
        const v = arg.slice(11);
        if (v !== "date" && v !== "seconds" && v !== "ns") {
          return {
            stdout: emptyStream(),
            stderr: fromString(
              `date: invalid argument '${v}' for '--rfc-3339'\n` +
                "Valid arguments are: 'date', 'seconds', 'ns'\n",
            ),
            exitCode: 1,
          };
        }
        rfc3339 = v;
      } else if (arg.startsWith("+")) fmt = arg.slice(1);
      else if (arg.startsWith("--")) return unknownOption("date", arg);
      else if (arg.startsWith("-")) {
        for (let j = 1; j < arg.length; j++) {
          const c = arg[j];
          if (c === "u") utc = true;
          else if (c === "I") iso = true;
          else if (c === "R") rfc = true;
          else if (c === "r") {
            // -r consumes the rest of the arg or the next arg.
            const rest = arg.slice(j + 1);
            refFile = rest !== "" ? rest : (a[++i] ?? "");
            break;
          } else return unknownOption("date", `-${c}`);
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

    let date: Date | null;
    if (refFile !== null) {
      try {
        const stat = await ctx.fs.stat(refFile);
        date = stat.mtime;
      } catch {
        return {
          stdout: emptyStream(),
          stderr: fromString(
            `date: cannot stat '${refFile}': No such file or directory\n`,
          ),
          exitCode: 1,
        };
      }
    } else if (dateStr !== null) {
      date = parseDate(dateStr, timeZone);
      if (!date)
        return {
          stdout: emptyStream(),
          stderr: fromString(`date: invalid date '${dateStr}'\n`),
          exitCode: 1,
        };
    } else {
      date = new Date();
    }

    let out: string;
    if (fmt) out = formatDate(date, fmt, timeZone);
    else if (rfc3339 === "date") out = formatDate(date, "%Y-%m-%d", timeZone);
    else if (rfc3339 === "seconds")
      out = formatDate(date, "%Y-%m-%d %H:%M:%S%:z", timeZone);
    else if (rfc3339 === "ns")
      out = formatDate(date, "%Y-%m-%d %H:%M:%S.%N%:z", timeZone);
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

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "date",
  flags: [
    { flag: "-d", type: "value", valueHint: "string" },
    { flag: "-u", type: "boolean" },
    { flag: "-I", type: "boolean" },
    { flag: "-R", type: "boolean" },
    { flag: "-r", type: "value", valueHint: "string" },
    { flag: "--timezone", type: "value", valueHint: "string" },
    { flag: "--rfc-3339", type: "value", valueHint: "string" },
  ],
};
