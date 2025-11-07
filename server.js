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
                cache = {
                    ...cache,
                    etag: data.etag,
                    lastModified: data.lastModified,
                    parsed: events,
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

const expressServer = app.listen(PORT, (error) => {
    error ? error : console.log(`listening port ${PORT}`)
})