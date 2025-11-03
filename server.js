const express = require('express');
const path = require('path');
// const mongoose = require('mongoose')
// const methodOverride = require('method-override')
const cors = require('cors');
// const jwt = require("jsonwebtoken");
const bodyParser = require('body-parser');
// const User = require("./models/user")

const ical = require("node-ical");
const axios = require("axios")

require('dotenv').config()


const PORT = process.env.PORT || 3000
// const db = `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASS}@${process.env.MONGO_URL}`

const app = express();
app.use(bodyParser.json()); // application/json - body
// app.use(express.urlencoded({ extended: false })); // forms body
app.use(express.static('public'))
app.use(cors());

async function getCalendarEvents() {
    console.log('calendars')
    // console.log('ical', ical)
    const url = "https://www.airbnb.com.ua/calendar/ical/1528333224165579132.ics?s=e5f8914cc0f8df58b5314f360444f73a"

    // const data = await axios.get(src, { responseType: "text", headers: { "User-Agent": "ical-proxy/1.0" } });
    // console.log('data', data)
    const resp = await axios.get(url, {
        responseType: "arraybuffer",
        headers: {
            "Accept": "text/calendar, text/plain; q=0.9, */*; q=0.8",
            "User-Agent": "ical-fetcher/1.0"
        }
    });

    // Преобразуем Buffer в UTF-8 строку
    const text = Buffer.from(resp.data).toString("utf8");
    const parsed = ical.parseICS(text);
    const events = [];
    for (const key in parsed) {
        const ev = parsed[key];
        if (ev.type === "VEVENT") {
            console.log('ev', ev)
            events.push({
                uid: ev.uid,
                // start: new Date(ev.start).toLocaleString("ru-UA", { timeZone: "Europe/Kyiv" }),
                // end: new Date(ev.end).toLocaleString("ru-UA", { timeZone: "Europe/Kyiv" }),
                start: ev.start,
                end: ev.end,
                summary: ev.summary || "Booking",
            });
        }
    }
    console.log('events', events)
    return events
}

//token verify
app.use(async (req, res, next) => {
    console.log('req', req.url)
    //
    if (req.url === '/api/getCalendarEvents') {
        const data = await getCalendarEvents()
        // res.status(200).send()
        res.status(200).json({
            data
        })
    } else {
    }

    next()
});

const expressServer = app.listen(PORT, (error) => {
    error ? error : console.log(`listening port ${PORT}`)
})

// const authRoutes = require('./routes/auth-route')
// const usersRoutes = require('./routes/users-route')

// mongoose
//     .connect(db)
//     .then(() => console.log('Connected'))
//     .catch((error) => console.log(error))

// app.use("/api/auth", authRoutes)
// app.use("/api/users", usersRoutes)