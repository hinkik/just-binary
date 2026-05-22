import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { toText } from "../../test-utils.js";

/** Format date in local timezone as YYYY-MM-DD */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("date", () => {
  describe("format specifiers", () => {
    it("should format year with %Y", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%Y"));
      expect(result.stdout).toMatch(/^\d{4}\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format month with %m", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%m"));
      expect(result.stdout).toMatch(/^(0[1-9]|1[0-2])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format day with %d", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%d"));
      expect(result.stdout).toMatch(/^(0[1-9]|[12]\d|3[01])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format ISO date with %F", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%F"));
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format time with %T", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%T"));
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format hours with %H", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%H"));
      expect(result.stdout).toMatch(/^([01]\d|2[0-3])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format 12-hour with %I", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%I"));
      expect(result.stdout).toMatch(/^(0[1-9]|1[0-2])\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format minutes with %M", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%M"));
      expect(result.stdout).toMatch(/^[0-5]\d\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format seconds with %S", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%S"));
      expect(result.stdout).toMatch(/^[0-5]\d\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format full weekday with %A", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -u -d '2026-05-22T12:00:00Z' +%A"),
      );
      expect(result.stdout).toBe("Friday\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format full month name with %B", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -u -d '2026-05-22T12:00:00Z' +%B"),
      );
      expect(result.stdout).toBe("May\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format %D as MM/DD/YY", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -u -d '2026-05-22T12:00:00Z' +%D"),
      );
      expect(result.stdout).toBe("05/22/26\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format day-of-year with %j", async () => {
      const env = new Bash();
      // 2024 is a leap year; Mar 1 -> day 061.
      const result = await toText(
        await env.exec("date -u -d '2024-03-01T00:00:00Z' +%j"),
      );
      expect(result.stdout).toBe("061\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format space-padded hour with %k", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -u -d '2026-05-22T05:00:00Z' +%k"),
      );
      expect(result.stdout).toBe(" 5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format century with %C", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -u -d '2026-05-22T12:00:00Z' +%C"),
      );
      expect(result.stdout).toBe("20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format weekday name with %a", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%a"));
      expect(result.stdout).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should format month name with %b", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%b"));
      expect(result.stdout).toMatch(
        /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\n$/,
      );
      expect(result.exitCode).toBe(0);
    });

    it("should format unix timestamp with %s", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%s"));
      const timestamp = Number.parseInt(result.stdout.trim(), 10);
      expect(timestamp).toBeGreaterThan(1700000000);
      expect(result.exitCode).toBe(0);
    });

    it("should format AM/PM with %p", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%p"));
      expect(result.stdout).toMatch(/^(AM|PM)\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle literal percent with %%", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date +%%"));
      expect(result.stdout).toBe("%\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle combined format string", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date '+%Y-%m-%d %H:%M:%S'"));
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle newline with %n", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date '+%Y%n%m'"));
      expect(result.stdout).toMatch(/^\d{4}\n\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle tab with %t", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date '+%Y%t%m'"));
      expect(result.stdout).toMatch(/^\d{4}\t\d{2}\n$/);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("options", () => {
    it("should parse date string with -d", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -d '2024-01-15T12:00:00' +%Y-%m-%d"),
      );
      expect(result.stdout).toBe("2024-01-15\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse date string with --date", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date --date='2024-06-20T12:00:00' +%F"),
      );
      expect(result.stdout).toBe("2024-06-20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should output ISO format with -I", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -I"));
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.exitCode).toBe(0);
    });

    it("should output RFC format with -R", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -R"));
      expect(result.stdout).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/,
      );
      expect(result.exitCode).toBe(0);
    });

    it("should output UTC with -u", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -u +%Z"));
      expect(result.stdout).toBe("UTC\n");
      expect(result.exitCode).toBe(0);
    });

    it("should output UTC timezone offset with -u", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -u +%z"));
      expect(result.stdout).toBe("+0000\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("relative dates", () => {
    it("should parse 'now'", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -d now +%s"));
      const timestamp = Number.parseInt(result.stdout.trim(), 10);
      const now = Math.floor(Date.now() / 1000);
      expect(Math.abs(timestamp - now)).toBeLessThan(5);
      expect(result.exitCode).toBe(0);
    });

    it("should parse 'today'", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -d today +%F"));
      // Use local date formatting to match date command behavior
      const today = formatLocalDate(new Date());
      expect(result.stdout).toBe(`${today}\n`);
      expect(result.exitCode).toBe(0);
    });

    it("should parse 'yesterday'", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -d yesterday +%F"));
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(result.stdout).toBe(`${formatLocalDate(yesterday)}\n`);
      expect(result.exitCode).toBe(0);
    });

    it("should parse 'tomorrow'", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -d tomorrow +%F"));
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(result.stdout).toBe(`${formatLocalDate(tomorrow)}\n`);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error on invalid date string", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec("date -d 'invalid date string xyz'"),
      );
      expect(result.stderr).toContain("invalid date");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date --unknown"));
      expect(result.stderr).toContain("unrecognized option");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown short option", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date -z"));
      expect(result.stderr).toContain("invalid option");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("help", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date --help"));
      expect(result.stdout).toContain("date");
      expect(result.stdout).toContain("FORMAT");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("timezone", () => {
    it("should honor --timezone for %Y-%m-%d %H:%M:%S", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date -d '2024-06-15T12:00:00Z' --timezone=America/New_York '+%F %T'",
        ),
      );
      // 2024-06-15 12:00:00 UTC -> 2024-06-15 08:00:00 EDT (UTC-4)
      expect(result.stdout).toBe("2024-06-15 08:00:00\n");
      expect(result.exitCode).toBe(0);
    });

    it("should honor --timezone for %z offset", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date -d '2024-01-15T12:00:00Z' --timezone=America/New_York +%z",
        ),
      );
      // January in NY is EST = UTC-5
      expect(result.stdout).toBe("-0500\n");
      expect(result.exitCode).toBe(0);
    });

    it("should honor --timezone for %z with positive offset", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date -d '2024-06-15T12:00:00Z' --timezone=Asia/Kolkata +%z",
        ),
      );
      // IST = UTC+05:30
      expect(result.stdout).toBe("+0530\n");
      expect(result.exitCode).toBe(0);
    });

    it("should honor --timezone=UTC", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date -d '2024-06-15T12:34:56Z' --timezone=UTC '+%F %T %z'",
        ),
      );
      expect(result.stdout).toBe("2024-06-15 12:34:56 +0000\n");
      expect(result.exitCode).toBe(0);
    });

    it("should read TZ from the environment", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "TZ=America/Los_Angeles date -d '2024-06-15T12:00:00Z' +%T",
        ),
      );
      // 2024-06-15 12:00:00 UTC -> 05:00:00 PDT
      expect(result.stdout).toBe("05:00:00\n");
      expect(result.exitCode).toBe(0);
    });

    it("should let -u override TZ", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "TZ=America/Los_Angeles date -u -d '2024-06-15T12:00:00Z' '+%T %z'",
        ),
      );
      expect(result.stdout).toBe("12:00:00 +0000\n");
      expect(result.exitCode).toBe(0);
    });

    it("should let --timezone override TZ", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "TZ=America/Los_Angeles date -d '2024-06-15T12:00:00Z' --timezone=UTC +%T",
        ),
      );
      expect(result.stdout).toBe("12:00:00\n");
      expect(result.exitCode).toBe(0);
    });

    it("should error on invalid timezone", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date --timezone=Not/AZone"));
      expect(result.stderr).toContain("invalid time zone");
      expect(result.exitCode).toBe(1);
    });

    it("should interpret bare timestamp in the target zone (--timezone)", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date --timezone=America/New_York -d '2024-06-15 12:00:00' '+%F %T %z'",
        ),
      );
      // June in NY is EDT (-0400). Bare wall-clock is preserved.
      expect(result.stdout).toBe("2024-06-15 12:00:00 -0400\n");
      expect(result.exitCode).toBe(0);
    });

    it("should interpret bare timestamp in $TZ", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "TZ=Asia/Tokyo date -d '2024-06-15 12:00:00' '+%F %T %z'",
        ),
      );
      expect(result.stdout).toBe("2024-06-15 12:00:00 +0900\n");
      expect(result.exitCode).toBe(0);
    });

    it("should still honor explicit Z suffix as UTC instant", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date --timezone=America/New_York -d '2024-06-15T12:00:00Z' '+%F %T %z'",
        ),
      );
      // Z pins to UTC; NY in June is -0400 -> 08:00:00 local.
      expect(result.stdout).toBe("2024-06-15 08:00:00 -0400\n");
      expect(result.exitCode).toBe(0);
    });

    it('should honor embedded TZ="..." inside -d', async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date --timezone=America/Los_Angeles -d 'TZ=\"Asia/Tokyo\" 2024-06-15 12:00:00' '+%F %T %z'",
        ),
      );
      // Input parsed as Tokyo wall-clock (+0900) = 2024-06-15T03:00:00Z
      // Output in LA (PDT, -0700) = 2024-06-14 20:00:00.
      expect(result.stdout).toBe("2024-06-14 20:00:00 -0700\n");
      expect(result.exitCode).toBe(0);
    });

    it("should abbreviate %Z from long zone name when Intl returns offset form", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date --timezone=Europe/Stockholm -d '2026-05-22T16:31:00+02:00' +%Z",
        ),
      );
      expect(result.stdout).toBe("CEST\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle DST spring-forward wall-clock correctly", async () => {
      const env = new Bash();
      const result = await toText(
        await env.exec(
          "date --timezone=America/New_York -d '2024-03-10 03:00:00' '+%F %T %z'",
        ),
      );
      // 03:00 on the morning of spring-forward; NY is EDT (-0400) by then.
      expect(result.stdout).toBe("2024-03-10 03:00:00 -0400\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("default output", () => {
    it("should output default format without arguments", async () => {
      const env = new Bash();
      const result = await toText(await env.exec("date"));
      // Default format includes weekday, month, day, time, timezone, year
      expect(result.stdout).toMatch(
        /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/,
      );
      expect(result.exitCode).toBe(0);
    });
  });

  // ground-truth strings below verified against GNU coreutils 9.7
  // (debian:stable-slim, container TZ=Europe/Stockholm or UTC as noted).
  describe("GNU-verified specifiers", () => {
    const TS = "2026-05-22T14:31:05.123+02:00"; // Fri 14:31:05 CEST, day 142
    const tz = "--timezone=Europe/Stockholm";

    async function run(args: string): Promise<string> {
      const env = new Bash();
      const r = await toText(await env.exec(`date ${args}`));
      expect(r.exitCode).toBe(0);
      return r.stdout;
    }

    it("ISO week %V %G %g", async () => {
      expect(await run(`-d '${TS}' ${tz} '+%G-W%V-%u'`)).toBe("2026-W21-5\n");
      expect(await run("-d '2024-12-30' -u '+%G-W%V-%u'")).toBe("2025-W01-1\n");
      expect(await run("-d '2023-01-01' -u '+%G-W%V-%u'")).toBe("2022-W52-7\n");
      expect(await run("-d '2024-01-01' -u '+%G-W%V-%u'")).toBe("2024-W01-1\n");
      expect(await run("-d '2024-12-30' -u '+%g'")).toBe("25\n");
    });

    it("quarter %q", async () => {
      expect(await run("-d '2024-01-15T00:00:00Z' -u +%q")).toBe("1\n");
      expect(await run("-d '2024-05-15T00:00:00Z' -u +%q")).toBe("2\n");
      expect(await run("-d '2024-08-15T00:00:00Z' -u +%q")).toBe("3\n");
      expect(await run("-d '2024-11-15T00:00:00Z' -u +%q")).toBe("4\n");
    });

    it("locale formats %c %r %x %X", async () => {
      expect(await run(`-d '${TS}' ${tz} +%c`)).toBe(
        "Fri May 22 14:31:05 2026\n",
      );
      expect(await run(`-d '${TS}' ${tz} +%r`)).toBe("02:31:05 PM\n");
      expect(await run(`-d '${TS}' ${tz} +%x`)).toBe("05/22/26\n");
      expect(await run(`-d '${TS}' ${tz} +%X`)).toBe("14:31:05\n");
    });

    it("offset variants %z %:z %::z %:::z", async () => {
      expect(await run(`-d '${TS}' ${tz} '+%z'`)).toBe("+0200\n");
      expect(await run(`-d '${TS}' ${tz} '+%:z'`)).toBe("+02:00\n");
      expect(await run(`-d '${TS}' ${tz} '+%::z'`)).toBe("+02:00:00\n");
      expect(await run(`-d '${TS}' ${tz} '+%:::z'`)).toBe("+02\n");
      // :::z minimal precision drops trailing :00 only when minutes are zero
      expect(
        await run("-d '2024-06-15T12:00:00Z' --timezone=Asia/Kolkata '+%:::z'"),
      ).toBe("+05:30\n");
    });

    it("pad modifiers", async () => {
      // 2026-05-22 14:31:05+02:00, in Stockholm; day=22, hour=14
      expect(await run(`-d '${TS}' ${tz} '+%-d %_d %0d'`)).toBe("22 22 22\n");
      // For single-digit values, the difference shows.
      expect(
        await run("-d '2024-06-05T05:00:00Z' -u '+%-d %_d %0d %-H %_H %0H'"),
      ).toBe("5  5 05 5  5 05\n");
      // Case modifiers — GNU: '#' uppercases if any lowercase; %#p lowercases.
      expect(await run(`-d '${TS}' ${tz} '+%^a %#A %#p'`)).toBe(
        "FRI FRIDAY pm\n",
      );
    });

    it("nanoseconds %N at varying widths (ms precision)", async () => {
      // JS only has ms precision — sub-ms zeroes are pad characters.
      expect(await run(`-d '${TS}' ${tz} '+%3N'`)).toBe("123\n");
      expect(await run(`-d '${TS}' ${tz} '+%6N'`)).toBe("123000\n");
      expect(await run(`-d '${TS}' ${tz} '+%9N'`)).toBe("123000000\n");
      expect(await run(`-d '${TS}' ${tz} '+%N'`)).toBe("123000000\n");
    });

    it("--rfc-3339 modes", async () => {
      expect(await run(`-d '${TS}' ${tz} --rfc-3339=date`)).toBe(
        "2026-05-22\n",
      );
      expect(await run(`-d '${TS}' ${tz} --rfc-3339=seconds`)).toBe(
        "2026-05-22 14:31:05+02:00\n",
      );
      expect(await run(`-d '${TS}' ${tz} --rfc-3339=ns`)).toBe(
        "2026-05-22 14:31:05.123000000+02:00\n",
      );
    });

    it("--rfc-3339 rejects invalid argument", async () => {
      const env = new Bash();
      const r = await toText(
        await env.exec(`date -d '${TS}' --rfc-3339=banana`),
      );
      expect(r.stderr).toContain("invalid argument");
      expect(r.exitCode).toBe(1);
    });

    it("midnight / noon for %I and %l", async () => {
      expect(await run("-d '2024-06-15T00:00:00Z' -u '+%I:%M %p'")).toBe(
        "12:00 AM\n",
      );
      expect(await run("-d '2024-06-15T12:00:00Z' -u '+%I:%M %p'")).toBe(
        "12:00 PM\n",
      );
      expect(await run("-d '2024-06-15T13:00:00Z' -u '+%I:%M %p'")).toBe(
        "01:00 PM\n",
      );
      expect(await run("-d '2024-06-15T05:00:00Z' -u '+%l:%M %p'")).toBe(
        " 5:00 AM\n",
      );
    });
  });

  describe("date arithmetic in -d", () => {
    async function run(args: string): Promise<string> {
      const env = new Bash();
      const r = await toText(await env.exec(`date ${args}`));
      expect(r.exitCode).toBe(0);
      return r.stdout;
    }

    it("ISO timestamp + N units", async () => {
      expect(await run("-d '2024-06-15T12:00:00Z + 1 day' -u '+%FT%TZ'")).toBe(
        "2024-06-16T12:00:00Z\n",
      );
      expect(
        await run("-d '2024-06-15T12:00:00Z + 5 hours' -u '+%FT%TZ'"),
      ).toBe("2024-06-15T17:00:00Z\n");
      expect(
        await run("-d '2024-06-15T12:00:00Z + 30 minutes' -u '+%FT%TZ'"),
      ).toBe("2024-06-15T12:30:00Z\n");
      expect(
        await run("-d '2024-06-15T12:00:00Z - 30 minutes' -u '+%FT%TZ'"),
      ).toBe("2024-06-15T11:30:00Z\n");
      expect(await run("-d '2024-06-15T12:00:00Z + 1 week' -u '+%FT%TZ'")).toBe(
        "2024-06-22T12:00:00Z\n",
      );
      expect(
        await run("-d '2024-06-15T12:00:00Z + 1 month' -u '+%FT%TZ'"),
      ).toBe("2024-07-15T12:00:00Z\n");
      expect(await run("-d '2024-06-15T12:00:00Z + 1 year' -u '+%FT%TZ'")).toBe(
        "2025-06-15T12:00:00Z\n",
      );
      expect(
        await run("-d '2024-06-15T12:00:00Z + 90 seconds' -u '+%FT%TZ'"),
      ).toBe("2024-06-15T12:01:30Z\n");
    });

    it("now-relative 'N units ago'", async () => {
      const env = new Bash();
      const before = Date.now();
      const r = await toText(await env.exec("date -d '5 minutes ago' +%s"));
      const after = Date.now();
      const ts = Number.parseInt(r.stdout.trim(), 10) * 1000;
      // expected: now - 5min = now - 300_000ms
      expect(ts).toBeGreaterThanOrEqual(before - 300_000 - 1000);
      expect(ts).toBeLessThanOrEqual(after - 300_000 + 1000);
    });

    it("now-relative bare 'N units' (future)", async () => {
      const env = new Bash();
      const before = Date.now();
      const r = await toText(await env.exec("date -d '2 hours' +%s"));
      const after = Date.now();
      const ts = Number.parseInt(r.stdout.trim(), 10) * 1000;
      expect(ts).toBeGreaterThanOrEqual(before + 7_200_000 - 1000);
      expect(ts).toBeLessThanOrEqual(after + 7_200_000 + 1000);
    });

    it("now-relative '1 week ago'", async () => {
      const env = new Bash();
      const before = Date.now();
      const r = await toText(await env.exec("date -d '1 week ago' +%s"));
      const ts = Number.parseInt(r.stdout.trim(), 10) * 1000;
      expect(ts).toBeLessThanOrEqual(before - 7 * 86_400_000 + 5000);
      expect(ts).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 5000);
    });

    it("compound 'yesterday HH:MM'", async () => {
      const env = new Bash();
      const r = await toText(
        await env.exec("date -d 'yesterday 12:00' -u +%T"),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("12:00:00\n");
    });

    it("compound 'today HH:MM:SS'", async () => {
      const env = new Bash();
      const r = await toText(await env.exec("date -d 'today 09:30:15' -u +%T"));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("09:30:15\n");
    });

    it("day name keyword: bare, next, last", async () => {
      const env = new Bash();
      const monday = await toText(await env.exec("date -d 'monday' +%u"));
      expect(monday.stdout).toBe("1\n");
      const nextMon = await toText(await env.exec("date -d 'next monday' +%u"));
      expect(nextMon.stdout).toBe("1\n");
      const lastFri = await toText(await env.exec("date -d 'last friday' +%u"));
      expect(lastFri.stdout).toBe("5\n");
    });

    it("'next monday' skips today even if today is monday", async () => {
      // Use a fixed reference via Date mocking would be ideal, but we can at
      // least assert that 'next monday' is strictly in the future.
      const env = new Bash();
      const r = await toText(await env.exec("date -d 'next monday' +%s"));
      const ts = Number.parseInt(r.stdout.trim(), 10) * 1000;
      expect(ts).toBeGreaterThan(Date.now());
    });

    it("'last friday' is strictly in the past", async () => {
      const env = new Bash();
      const r = await toText(await env.exec("date -d 'last friday' +%s"));
      const ts = Number.parseInt(r.stdout.trim(), 10) * 1000;
      expect(ts).toBeLessThan(Date.now());
    });
  });

  describe("-r FILE", () => {
    it("reads a file's mtime", async () => {
      const env = new Bash();
      const r = await toText(
        await env.exec(
          "echo hi > /tmp/probe.txt && date -r /tmp/probe.txt -u +%Y",
        ),
      );
      // mtime year should be current-ish (>= 2025 in any plausible CI/dev).
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const y = Number.parseInt(r.stdout.trim(), 10);
      expect(y).toBeGreaterThanOrEqual(2025);
    });

    it("errors for a missing file", async () => {
      const env = new Bash();
      const r = await toText(await env.exec("date -r /no/such/file"));
      expect(r.stderr).toContain("cannot stat");
      expect(r.exitCode).toBe(1);
    });

    it("supports --reference=FILE long form", async () => {
      const env = new Bash();
      const r = await toText(
        await env.exec(
          "echo hi > /tmp/probe2.txt && date --reference=/tmp/probe2.txt -u +%Y",
        ),
      );
      expect(r.exitCode).toBe(0);
      const y = Number.parseInt(r.stdout.trim(), 10);
      expect(y).toBeGreaterThanOrEqual(2025);
    });
  });
});
