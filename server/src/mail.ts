// Sending e-mail (confirming an address, resetting a password) through any SMTP
// server, e.g. Gmail with an app password: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465,
// SMTP_USER=you@gmail.com, SMTP_PASS=<app password>. Without SMTP_HOST, e-mail is off.

import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createSmtpMailer(env: NodeJS.ProcessEnv): Mailer | null {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // 465 is TLS from the start; 587 upgrades with STARTTLS.
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
  });
  const from = env.SMTP_FROM || (env.SMTP_USER ? `Voxa <${env.SMTP_USER}>` : "Voxa <no-reply@localhost>");
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A short message with one button, readable in any mail app (and as plain text). */
export function actionMail(to: string, subject: string, intro: string, button: string, url: string, outro: string): Mail {
  return {
    to,
    subject,
    text: `${intro}\n\n${button}: ${url}\n\n${outro}\n\n— Voxa`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1a2e">
  <h2 style="margin:0 0 16px;color:#7b3fe4">Voxa</h2>
  <p>${escape(intro)}</p>
  <p style="margin:24px 0"><a href="${escape(url)}" style="background:linear-gradient(90deg,#9d5cff,#3dd6ff);color:#08070f;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">${escape(button)}</a></p>
  <p style="color:#666;font-size:13px">${escape(outro)}</p>
  <p style="color:#999;font-size:12px">Se o botão não funcionar, copie este link: ${escape(url)}</p>
</div>`,
  };
}
