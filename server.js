const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const ical = require("node-ical");
const axios = require("axios");
const http = require("http");
const https = require("https");
require("dotenv").config();

const PORT = process.env.PORT || 3001;
const ICS_URL = `https://www.airbnb.com.ua/calendar/ical/${process.env.ICS_KEY}`;
const CALENDAR_TZ = "Europe/Kyiv";
const TTL_MS = 1000 * 60 * 3;

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));
app.use(cors());

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

let cache = {
    etag: null,
    lastModified: null,
    parsed: null,
    raw: null,
    expiresAt: 0,
    inFlight: null,
};

const EXTRA_BLOCK_RANGES = [
    { month: 0, startDay: 1, endDay: 1 },
    { month: 0, startDay: 5, endDay: 6 },
    { month: 0, startDay: 9, endDay: 11 },
    { month: 0, startDay: 13, endDay: 14 },
    { month: 0, startDay: 16, endDay: 17 },
    { month: 0, startDay: 20, endDay: 25 },
    { month: 0, startDay: 27, endDay: 27 },
    { month: 0, startDay: 30, endDay: 30 },
    { month: 1, startDay: 4, endDay: 4 },
    { month: 1, startDay: 6, endDay: 7 },
    { month: 1, startDay: 9, endDay: 9 },
    { month: 1, startDay: 14, endDay: 15 },
    { month: 1, startDay: 17, endDay: 17 },
    { month: 1, startDay: 20, endDay: 21 },
    { month: 1, startDay: 27, endDay: 28 },
    { month: 2, startDay: 1, endDay: 2 },
    { month: 2, startDay: 6, endDay: 7 },
    { month: 2, startDay: 12, endDay: 12 },
    { month: 2, startDay: 14, endDay: 16 },
    { month: 2, startDay: 20, endDay: 23 },
    { month: 2, startDay: 27, endDay: 29 },
    { month: 3, startDay: 2, endDay: 5 },
];

function ymdFormatter(timeZone = CALENDAR_TZ) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
}

const kyivYmd = ymdFormatter(CALENDAR_TZ);

function toYmdInTz(date, formatter = kyivYmd) {
    return formatter.format(date); // YYYY-MM-DD
}

function addDaysToYmd(ymd, days) {
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
}

function expandDateRange(startYmd, endYmdInclusive) {
    const result = [];
    let current = startYmd;

    while (current <= endYmdInclusive) {
        result.push(current);
        current = addDaysToYmd(current, 1);
    }

    return result;
}

function getCurrentYearInKyiv() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Kyiv",
        year: "numeric",
    }).formatToParts(new Date());

    return Number(parts.find((p) => p.type === "year").value);
}

function buildManualEvents() {
    const year = getCurrentYearInKyiv();

    return EXTRA_BLOCK_RANGES
        .map((r, idx) => {
            const month = String(r.month + 1).padStart(2, "0");
            const startDay = String(r.startDay).padStart(2, "0");
            const endDay = String(r.endDay).padStart(2, "0");

            const startDate = `${year}-${month}-${startDay}`;
            const endDateInclusive = `${year}-${month}-${endDay}`;
            const endDateExclusive = addDaysToYmd(endDateInclusive, 1);

            if (endDateInclusive < startDate) return null;

            return {
                uid: `manual-${year}-${idx}`,
                summary: "Manual block",
                startDate,
                endDateExclusive,
                endDateInclusive,
                blockedDates: expandDateRange(startDate, endDateInclusive),
            };
        })
        .filter(Boolean);
}

async function fetchIcs({ useValidators = true } = {}) {
    const headers = {
        Accept: "text/calendar, text/plain; q=0.9, */*; q=0.8",
        "User-Agent": "ical-fetcher/1.0",
    };

    if (useValidators && cache.etag) {
        headers["If-None-Match"] = cache.etag;
    }
    if (useValidators && cache.lastModified) {
        headers["If-Modified-Since"] = cache.lastModified;
    }

    const resp = await axios.get(ICS_URL, {
        responseType: "arraybuffer",
        timeout: 5000,
        headers,
        httpAgent: keepAliveHttp,
        httpsAgent: keepAliveHttps,
        decompress: true,
        validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
    });

    if (resp.status === 304 && cache.raw) {
        return {
            body: cache.raw,
            etag: cache.etag,
            lastModified: cache.lastModified,
            status: 304,
        };
    }

    return {
        body: Buffer.from(resp.data).toString("utf8"),
        etag: resp.headers.etag || null,
        lastModified: resp.headers["last-modified"] || null,
        status: resp.status,
    };
}

function normalizeEvent(ev) {
    if (!ev || ev.type !== "VEVENT" || !ev.start || !ev.end) {
        return null;
    }

    // Нормализуем в единую таймзону объекта
    const startDate = toYmdInTz(ev.start);
    const endDateExclusive = toYmdInTz(ev.end);

    // В iCal checkout день обычно НЕ должен блокироваться
    const endDateInclusive = addDaysToYmd(endDateExclusive, -1);

    // Защита от кривых данных
    if (endDateInclusive < startDate) {
        return null;
    }

    return {
        uid: ev.uid || `${startDate}-${endDateExclusive}`,
        summary: ev.summary || "Booking",
        startDate,
        endDateExclusive,
        endDateInclusive,
        blockedDates: expandDateRange(startDate, endDateInclusive),
    };
}

async function getCalendarEvents() {
    const now = Date.now();

    if (cache.parsed && now < cache.expiresAt) {
        return cache.parsed;
    }

    if (!cache.inFlight) {
        cache.inFlight = (async () => {
            let data;

            try {
                data = await fetchIcs({ useValidators: true });
            } catch (e) {
                if (cache.parsed) return cache.parsed;
                throw e;
            }

            if (data.status !== 304) {
                const parsedIcs = ical.parseICS(data.body);
                const events = [];

                for (const key in parsedIcs) {
                    const normalized = normalizeEvent(parsedIcs[key]);
                    if (normalized) events.push(normalized);
                }

                const manualEvents = buildManualEvents();

                const mergedEvents = [...events, ...manualEvents].sort(
                    (a, b) => a.start - b.start
                );

                cache.etag = data.etag;
                cache.lastModified = data.lastModified;
                cache.parsed = mergedEvents;
                cache.raw = data.body;
                cache.expiresAt = now + TTL_MS;
            } else {
                cache.expiresAt = now + TTL_MS;
            }

            return cache.parsed;
        })()
            .catch((err) => {
                throw err;
            })
            .finally(() => {
                cache.inFlight = null;
            });
    }

    return cache.inFlight;
}

app.get("/api/getCalendarEvents", async (req, res) => {
    const t0 = process.hrtime.bigint();

    try {
        const events = await getCalendarEvents();

        // Для фронта сразу готовый flat-массив всех занятых дней
        const blockedDates = [...new Set(events.flatMap((e) => e.blockedDates))].sort();

        res.set("Cache-Control", "public, max-age=60");
        res.status(200).json({
            data: events,
            blockedDates,
            timeZone: CALENDAR_TZ,
        });
    } catch (err) {
        console.error("getCalendarEvents error:", err?.message || err);
        res.status(504).json({ error: "Upstream timeout or fetch error" });
    } finally {
        const t1 = process.hrtime.bigint();
        console.log("getCalendarEvents total_ms=", Number(t1 - t0) / 1e6);
    }
});

getCalendarEvents().catch((e) => {
    console.error("Initial warmup failed:", e?.message || e);
});

app.listen(PORT, () => {
    console.log(`listening port ${PORT}`);
});