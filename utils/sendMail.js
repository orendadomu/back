
const sendMailOptions = {
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.MAIL_TRANSPORTER_USER,
        pass: process.env.MAIL_TRANSPORTER_PASS,
    },
}

const sendMailTypes = {
    "verify-email": {
        subject: "Confirm your email",
        text: "Your new account was created. Please confirm your data via link:",
    },
    "reset-password": {
        subject: "Reset your password",
        text: "We received a request to reset your account password. Confirm via link:",
    }
}

module.exports = {
    sendMailOptions,
    sendMailTypes
}