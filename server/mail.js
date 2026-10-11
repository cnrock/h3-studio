import nodemailer from 'nodemailer';
import { config } from './config.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { host, port, secure, requireTLS, user, pass, rejectUnauthorized } = config.smtp;
  const opts = {
    host,
    port,
    secure,
    requireTLS,
    auth: user ? { user, pass } : undefined,
    tls: { rejectUnauthorized },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
  transporter = nodemailer.createTransport(opts);
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  return t.sendMail({ from: config.smtp.from, to, subject, text, html });
}

export async function verifyMailer() {
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
