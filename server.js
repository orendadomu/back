const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const ical = require("node-ical");
const axios = require("axios")

const http = require("http")
const https = require("https")

require('dotenv').config()


const PORT = process.env.PORT || 3001

const app = express();
app.use(bodyParser.json()); // application/json - body
// app.use(express.urlencoded({ extended: false })); // forms body
app.use(express.static('public'))
app.use(cors());

const ICS_URL = `https://www.airbnb.com.ua/calendar/ical/${process.env.ICS_KEY}`;

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

let cache = {
    etag: null,
    lastModified: null,
    parsed: null,
    raw: null,
    // когда кэш истекает
    expiresAt: 0,
    // чтобы не дублировать одновременные fetch'и
    inFlight: null,
};
const TTL_MS = 1000 * 60 * 3; // 3 минуты

const EXTRA_BLOCK_RANGES = [
    // { month: 9, startDay: 9, endDay: 11 },
    // { month: 9, startDay: 17, endDay: 17 },
    // { month: 9, startDay: 19, endDay: 20 },
    // { month: 9, startDay: 25, endDay: 25 },
    // { month: 9, startDay: 27, endDay: 31 },
    // { month: 10, startDay: 2, endDay: 3 },
    // { month: 10, startDay: 6, endDay: 13 },
    // { month: 10, startDay: 14, endDay: 19 },
    // { month: 10, startDay: 21, endDay: 31 },
    // { month: 11, startDay: 1, endDay: 3 },
    // { month: 11, startDay: 4, endDay: 14 },
    // { month: 11, startDay: 15, endDay: 31 },
    
    { month: 0, startDay: 1, endDay: 2 },
    { month: 0, startDay: 5, endDay: 7 },
    { month: 0, startDay: 9, endDay: 12 },
    { month: 0, startDay: 13, endDay: 15 },
    // { month: 0, startDay: 16, endDay: 19 },
];

// Генерация событий из ручных диапазонов
function buildManualEvents() {
    const now = new Date();
    const year = now.getFullYear(); // "этого года"
    // console.log('year', year)

    return EXTRA_BLOCK_RANGES.map((r, idx) => {
        const start = new Date(Date.UTC(year, r.month, r.startDay, 0, 0, 0));
        const end = new Date(Date.UTC(year, r.month, r.endDay, 0, 0, 0));

        return {
            uid: `manual-${year}-${idx}`,
            start,
            end,
            summary: "Manual block",
        };
    });
}


async function fetchIcs({ useValidators = true } = {}) {
    const headers = {
        "Accept": "text/calendar, text/plain; q=0.9, */*; q=0.8",
        "User-Agent": "ical-fetcher/1.0",
    };
    if (useValidators && cache.etag) headers["If-None-Match"] = cache.etag;
    if (useValidators && cache.lastModified) headers["If-Modified-Since"] = cache.lastModified;

    const resp = await axios.get(ICS_URL, {
        responseType: "arraybuffer",
        timeout: 3000, // не даём виснуть
        headers,
        httpAgent: keepAliveHttp,
        httpsAgent: keepAliveHttps,
        // axios сам распакует gzip/deflate
        decompress: true,
        validateStatus: s => (s >= 200 && s < 300) || s === 304,
    });

    if (resp.status === 304 && cache.raw) {
        // не изменилось — используем прежнее тело
        return { body: cache.raw, etag: cache.etag, lastModified: cache.lastModified, status: 304 };
    }

    const body = Buffer.from(resp.data).toString("utf8");
    return {
        body,
        etag: resp.headers.etag || null,
        lastModified: resp.headers["last-modified"] || null,
        status: resp.status,
    };
}

// Единая функция: вернёт events из кэша или обновит его
async function getCalendarEvents() {
    const now = Date.now();

    // Тёплый кэш?
    if (cache.parsed && now < cache.expiresAt) {
        return cache.parsed;
    }

    // Один fetch на всех параллельных запросах
    if (!cache.inFlight) {
        cache.inFlight = (async () => {
            // Сначала пробуем валидаторы (дёшево)
            let data;
            try {
                data = await fetchIcs({ useValidators: true });
            } catch (e) {
                // Если сеть упала, но есть старый кэш — вернём его
                if (cache.parsed) return cache.parsed;
                throw e;
            }

            // Обновляем кэш, если новое тело
            if (data.status !== 304) {
                const parsedIcs = ical.parseICS(data.body);
                const events = [];

                for (const k in parsedIcs) {
                    const ev = parsedIcs[k];
                    if (ev?.type === "VEVENT") {
                        events.push({
                            uid: ev.uid,
                            start: ev.start, // ISO Date
                            end: ev.end,
                            summary: ev.summary || "Booking",
                        });
                    }
                }

                const manualEvents = buildManualEvents();

                // Просто склеиваем и сортируем по времени начала
                const mergedEvents = [...events, ...manualEvents].sort(
                    (a, b) => a.start - b.start
                );

                cache = {
                    ...cache,
                    etag: data.etag,
                    lastModified: data.lastModified,
                    // parsed: events,
                    parsed: mergedEvents,
                    raw: data.body,
                    expiresAt: now + TTL_MS,
                    inFlight: null,
                };
            } else {
                // Только продлеваем TTL
                cache.expiresAt = now + TTL_MS;
            }
            return cache.parsed;
        })();
    }

    return cache.inFlight.finally(() => {
        // сбросим ссылку на промис, когда закончится
        cache.inFlight = null;
    });
}

// Роут без next() после ответа
app.get("/api/getCalendarEvents", async (req, res) => {
    const t0 = process.hrtime.bigint();
    try {
        const events = await getCalendarEvents();
        res.set("Cache-Control", "public, max-age=60"); // клиенту тоже можно кэшировать минуту
        res.status(200).json({ data: events });
    } catch (err) {
        console.error("getCalendarEvents error:", err?.message || err);
        // быстрый фейл вместо 10-сек зависания
        res.status(504).json({ error: "Upstream timeout or fetch error" });
    } finally {
        const t1 = process.hrtime.bigint();
        console.log("getCalendarEvents total_ms=", Number(t1 - t0) / 1e6);
    }
});

// app.post("/api/send-phone", async (req, res) => {
//     try {
//         const { phone, extra = "" } = req.body || {};
//         const normalized = String(phone || "").replace(/[^\d+]/g, "");
//         if (!/^\+?\d{10,15}$/.test(normalized)) {
//             return res.status(400).json({ ok: false, error: "Invalid phone format" });
//         }

//         const text = [
//             "📲 Новая заявка с сайта",
//             `• Телефон: ${normalized}`,
//             extra ? `• Комментарий: ${String(extra).slice(0, 500)}` : "",
//             `• Время: ${new Date().toISOString()}`
//         ].filter(Boolean).join("\n");

//         const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
//             method: "POST",
//             headers: { "Content-Type": "application/json" },
//             body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
//         });
//         const data = await r.json();
//         if (!data.ok) throw new Error(data.description || "Telegram API error");

//         res.json({ ok: true });
//     } catch (e) {
//         res.status(500).json({ ok: false, error: e.message });
//     }
// });

setInterval(() => {
    getCalendarEvents().catch(() => { });
}, 10 * 60 * 1000);

const expressServer = app.listen(PORT, (error) => {
    error ? error : console.log(`listening port ${PORT}`)
})