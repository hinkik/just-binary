/**
 * date - Display the current date and time
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs, EMPTY, encode } from "../../utils/bytes.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const dateHelp = {
  name: "date",
  summary: "display the current time in the given FORMAT",
  usage: "date [OPTION]... [+FORMAT]",
  options: [
    "-d, --date=STRING   display time described by STRING",
    "-u, --utc           print Coordinated Universal Time (UTC)",
    "-I, --iso-8601      output date/time in ISO 8601 format",
    "-R, --rfc-email     output RFC 5322 date format",
    "    --help          display this help and exit",
  ],
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function tzOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

function formatDate(d: Date, fmt: string, utc: boolean): string {
  const g = utc
    ? {
        Y: d.getUTCFullYear(),
        m: d.getUTCMonth(),
        D: d.getUTCDate(),
        H: d.getUTCHours(),
        M: d.getUTCMinutes(),
        S: d.getUTCSeconds(),
        w: d.getUTCDay(),
      }
    : {
        Y: d.getFullYear(),
        m: d.getMonth(),
        D: d.getDate(),
        H: d.getHours(),
        M: d.getMinutes(),
        S: d.getSeconds(),
        w: d.getDay(),
      };

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
        case "b":
        case "h":
          r += MONTHS[g.m];
          break;
        case "d":
          r += pad(g.D);
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
          r += utc ? "+0000" : tzOffset(d);
          break;
        case "Z":
          r += utc ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
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

function parseDate(s: string): Date | null {
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  if (/^\d+$/.test(s)) return new Date(Number.parseInt(s, 10) * 1000);
  const l = s.toLowerCase();
  if (l === "now" || l === "today") return new Date();
  if (l === "yesterday") return new Date(Date.now() - 86400000);
  if (l === "tomorrow") return new Date(Date.now() + 86400000);
  return null;
}

export const dateCommand: Command = {
  name: "date",
  async execute(args: Uint8Array[], _ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) return showHelp(dateHelp);

    let utc = false,
      dateStr: string | null = null,
      fmt: string | null = null,
      iso = false,
      rfc = false;

    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      if (arg === "-u" || arg === "--utc") utc = true;
      else if (arg === "-d" || arg === "--date") dateStr = a[++i] ?? "";
      else if (arg.startsWith("--date=")) dateStr = arg.slice(7);
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

    const date = dateStr !== null ? parseDate(dateStr) : new Date();
    if (!date)
      return {
        stdout: EMPTY,
        stderr: encode(`date: invalid date '${dateStr}'\n`),
        exitCode: 1,
      };

    let out: string;
    if (fmt) out = formatDate(date, fmt, utc);
    else if (iso) out = formatDate(date, "%Y-%m-%dT%H:%M:%S%z", utc);
    else if (rfc) out = formatDate(date, "%a, %d %b %Y %H:%M:%S %z", utc);
    else out = formatDate(date, "%a %b %e %H:%M:%S %Z %Y", utc);

    return { stdout: encode(`${out}\n`), stderr: EMPTY, exitCode: 0 };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "date",
  flags: [
    { flag: "-d", type: "value", valueHint: "string" },
    { flag: "-u", type: "boolean" },
    { flag: "-I", type: "boolean" },
    { flag: "-R", type: "boolean" },
  ],
};
