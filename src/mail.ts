/** Shared SMTP mailer (office digest, fee emails). Env: SMTP_HOST, SMTP_PORT (465), SMTP_USER, SMTP_PASS, SMTP_FROM. */
import nodemailer from "nodemailer";

let t: nodemailer.Transporter | null = null;
export function mailer(): nodemailer.Transporter {
  const host = process.env.SMTP_HOST;
  if (!host || !process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error("SMTP_HOST / SMTP_USER / SMTP_PASS are not set");
  if (!t) {
    const port = Number(process.env.SMTP_PORT ?? 465);
    t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  }
  return t;
}
/** "GLO Preschool <school@gmail.com>" */
export const mailFrom = (name: string) => `${name} <${process.env.SMTP_FROM ?? process.env.SMTP_USER}>`;

/** Fee emails (invoices, reminders, receipts) go from fees@gloschools.com: FEE_SMTP_HOST/PORT/USER/PASS, falling back
 * to the SMTP_* settings above if those are not set. */
let ft: nodemailer.Transporter | null = null;
export function feeMailer(): nodemailer.Transporter {
  if (!process.env.FEE_SMTP_USER) return mailer();
  const host = process.env.FEE_SMTP_HOST, pass = process.env.FEE_SMTP_PASS;
  if (!host || !pass) throw new Error("FEE_SMTP_HOST / FEE_SMTP_PASS are not set");
  if (!ft) {
    const port = Number(process.env.FEE_SMTP_PORT ?? 465);
    ft = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: process.env.FEE_SMTP_USER, pass } });
  }
  return ft;
}
export const feeFrom = (name: string) => `${name} <${process.env.FEE_SMTP_USER ?? process.env.SMTP_FROM ?? process.env.SMTP_USER}>`;
