// Sends the e-mails of the server. Only one kind exists so far: the password reset link.
import nodemailer from 'nodemailer';

// SMTP_URL is the connection to a mail account, e.g. smtps://you%40gmail.com:app-password@smtp.gmail.com
// (any provider works; with Gmail the password is an "app password"). Without it no mail is sent:
// the link is printed in the server's log instead, which is enough while developing.
const smtpUrl = process.env.SMTP_URL;
const from = process.env.MAIL_FROM || 'Sketchspace <no-reply@localhost>';
const transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;

export const isMailConfigured = transport !== null;

export async function sendPasswordResetEmail(to: string, link: string): Promise<void> {
  if (!transport) {
    // never print a working reset link into the log of a real deployment
    if (process.env.NODE_ENV === 'production') console.warn('Password reset requested, but SMTP_URL is not set: no e-mail sent');
    else console.log(`[mail not configured] Password reset link for ${to}:\n${link}`);
    return;
  }
  await transport.sendMail({
    from,
    to,
    subject: 'Reset your Sketchspace password',
    text:
      `Someone asked to reset the password of your Sketchspace account.\n\n` +
      `Choose a new password here (the link works for one hour, and once):\n${link}\n\n` +
      `If it was not you, ignore this e-mail: your password stays as it is.`,
    html:
      `<p>Someone asked to reset the password of your Sketchspace account.</p>` +
      `<p><a href="${link}">Choose a new password</a> (the link works for one hour, and once).</p>` +
      `<p>If it was not you, ignore this e-mail: your password stays as it is.</p>`,
  });
}
