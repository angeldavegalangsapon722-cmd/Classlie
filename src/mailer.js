const nodemailer = require("nodemailer");

// Email is optional. Set either SMTP_* (e.g. a Gmail App Password) or RESEND_API_KEY.
let transport;
let cached = false;

function buildTransport() {
  if (process.env.RESEND_API_KEY) {
    return nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      auth: { user: "resend", pass: process.env.RESEND_API_KEY }
    });
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port = Number(process.env.SMTP_PORT || 587);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return null;
}

function getTransport() {
  if (!cached) { transport = buildTransport(); cached = true; }
  return transport;
}

function mailerConfigured() {
  return Boolean(getTransport());
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || "Classlie <no-reply@localhost>";
}

// Returns true when the message was actually handed to the mail server.
async function sendMail({ to, subject, text, html }) {
  const sender = getTransport();
  if (!sender) {
    console.warn(`Email is not configured (SMTP_* or RESEND_API_KEY). Skipped “${subject}” to ${to}.`);
    return false;
  }
  await sender.sendMail({ from: fromAddress(), to, subject, text, html });
  return true;
}

module.exports = { sendMail, mailerConfigured, fromAddress };
