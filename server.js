import express from "express";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import multer from "multer";

dotenv.config();

const app = express();
app.use(express.json({ limit: "15mb" })); // allow base64 images
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// If you still want the HTML UI:
app.use(express.static(path.join(__dirname, "public")));

// ---- SQLite: open your existing DB file ----
const sqlitePath = process.env.SQLITE_PATH || "./db.sqlite";
const db = new sqlite3.Database(path.resolve(__dirname, sqlitePath));

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // for tracking pixel

console.log("public base URL:", PUBLIC_BASE_URL);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function newReadToken() {
  return crypto.randomBytes(16).toString("hex");
}

function injectTrackingPixel(html, token) {
  if (!PUBLIC_BASE_URL) return html; // skip if not configured
  const pixel = `<img src="${PUBLIC_BASE_URL}/t/${token}.png" width="1" height="1" style="display:none" alt="" />`;
  if (html.includes("</body>")) return html.replace("</body>", `${pixel}</body>`);

  return html + pixel;
}

// "valid" in practice:
// - 1 if syntax OK
// - 0 if syntax invalid OR server returned a hard-bounce-like error
function looksLikeInvalidRecipient(err) {
  const msg = String(err?.message || "");
  const resp = String(err?.response || "");
  const code = String(err?.responseCode || "");
  const hay = (msg + " " + resp + " " + code).toLowerCase();

  return (
    hay.includes("5.1.1") ||
    hay.includes("user unknown") ||
    hay.includes("no such user") ||
    hay.includes("recipient address rejected") ||
    hay.includes("mailbox unavailable") ||
    hay.includes("550")
  );
}


//---- Nodemailer transporter (your email will send) ----
const transporter = nodemailer.createTransport({
  sendmail: true,
  newline: "unix",
  path: "/usr/sbin/sendmail", // usually this path on Ubuntu
});

// ---- IMPORTANT: pick the right column from your table `email` ----
// If your table is like: CREATE TABLE email (email TEXT);
// then this query is correct.
const RECIPIENTS_QUERY = `
  SELECT id, email as addr
  FROM test_emails
`;
// If your column is named differently, change above, e.g.
// SELECT address as addr FROM email
// SELECT mail as addr FROM email

// ---------- TRACKING ENDPOINT ----------
app.get("/t/:token.png", (req, res) => {
  const token = String(req.params.token || "").replace(".png", "").trim();
  if (!token) return res.status(400).end();

  const ip =
    (req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "").toString().split(",")[0].trim();

  const agent = String(req.headers["user-agent"] || "").slice(0, 300);

  db.run(
    `UPDATE test_emails
     SET is_read = 1,
         last_read_at = datetime('now'),
         ip = ?,
         agent = ?
     WHERE read_token = ?`,
    [ip, agent, token],
    () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X9l3cAAAAASUVORK5CYII=",
        "base64"
      );
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.end(png);
    }
  );
});

// ---------- STATUS LIST ----------
app.get("/api/status", (req, res) => {
  db.all(
    `SELECT id, email, is_valid, is_sent, is_read, ip, agent
     FROM test_emails
     ORDER BY id DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error("DB read error:", err);
        return res.status(500).json({ error: "DB read failed.", details: String(err) });
      }
      res.json({ ok: true, rows });
    }
  );
});

// ---------- SEND (INDIVIDUAL ONLY, HTML UPLOAD) ----------
app.post("/api/send", upload.single("template"), async (req, res) => {
  try {
    const subject = String(req.body.subject || "").trim();

    // Allow UI override of From display name/email (Gmail may enforce SMTP_USER)
    const fromName = String(req.body.fromName || process.env.FROM_NAME || "Mailer").trim();
    const fromEmail = String(req.body.fromEmail || process.env.SMTP_USER || "").trim();

    if (!subject) return res.status(400).json({ error: "Subject is required." });
    if (!fromEmail || !isValidEmail(fromEmail)) return res.status(400).json({ error: "Valid From Email is required." });
    if (!req.file) return res.status(400).json({ error: "HTML file is required (field name: template)." });

    const rawHtml = req.file.buffer.toString("utf-8");
    if (!rawHtml || rawHtml.trim().length < 20) {
      return res.status(400).json({ error: "HTML file looks empty." });
    }

    const from = `"${fromName}" <${fromEmail}>`;

    db.all(RECIPIENTS_QUERY, [], async (err, rows) => {
      if (err) return res.status(500).json({ error: "DB read failed.", details: String(err) });

      const results = [];

      for (const row of rows || []) {
        const id = row.id;
        const to = String(row.addr || "").trim();

        // compute initial validity by syntax
        const validSyntax = isValidEmail(to) ? 1 : 0;

        // new tracking token + reset statuses for this campaign
        const token = newReadToken();

        await new Promise((resolve) => {
          db.run(
            `UPDATE test_emails
             SET is_valid = ?,
                 is_sent = 0,
                 is_read = 0,
                 read_token = ?,
                 last_sent_at = datetime('now')
             WHERE id = ?`,
            [validSyntax, token, id],
            () => resolve()
          );
        });

        if (!validSyntax) {
          results.push({ id, to, ok: false, error: "invalid email format" });
          continue;
        }

        // inject tracking pixel
        const htmlWithPixel = injectTrackingPixel(rawHtml, token);

        try {
          const info = await transporter.sendMail({
            from,
            to,
            subject,
            html: htmlWithPixel,
          });

          await new Promise((resolve) => {
            db.run(`UPDATE test_emails SET is_sent = 1 WHERE id = ?`, [id], () => resolve());
          });

          results.push({ id, to, ok: true, messageId: info.messageId });
        } catch (e) {
          const invalid = looksLikeInvalidRecipient(e) ? 0 : 1;

          await new Promise((resolve) => {
            db.run(
              `UPDATE test_emails
               SET is_sent = 0,
                   is_valid = ?
               WHERE id = ?`,
              [invalid, id],
              () => resolve()
            );
          });

          results.push({ id, to, ok: false, error: String(e?.message || "send failed") });
        }

        // throttle to reduce resets/rate limits
        await sleep(2000);
      }

      const sent = results.filter(r => r.ok).length;
      return res.json({ ok: true, total: results.length, sent, results });
    });
  } catch (e) {
    return res.status(500).json({ error: "Send failed.", details: String(e?.message || e) });
  }
});

// ---------- SEND ONE (RESEND) ----------
app.post("/api/send-one", upload.single("template"), async (req, res) => {
  try {
    const to = String(req.body.to || "").trim();
    const subject = String(req.body.subject || "").trim();

    const fromName = String(req.body.fromName || process.env.FROM_NAME || "Mailer").trim();
    const fromEmail = String(req.body.fromEmail || process.env.SMTP_USER || "").trim();

    if (!to) return res.status(400).json({ error: "Recipient (to) is required." });
    if (!isValidEmail(to)) return res.status(400).json({ error: "Invalid recipient email." });
    if (!subject) return res.status(400).json({ error: "Subject is required." });
    if (!fromEmail || !isValidEmail(fromEmail)) return res.status(400).json({ error: "Valid From Email is required." });
    if (!req.file) return res.status(400).json({ error: "HTML file is required (field name: template)." });

    const rawHtml = req.file.buffer.toString("utf-8");
    if (!rawHtml || rawHtml.trim().length < 20) {
      return res.status(400).json({ error: "HTML file looks empty." });
    }

    // find row by email to update statuses
    db.get(`SELECT id FROM test_emails WHERE email = ?`, [to], async (err, row) => {
      const id = row?.id;

      const token = newReadToken();
      const htmlWithPixel = injectTrackingPixel(rawHtml, token);

      console.log('htmlWithPixel:', htmlWithPixel);

      // update reset statuses (if row exists)
      if (id) {
        db.run(
          `UPDATE test_emails
           SET is_valid = 1,
               is_sent = 0,
               is_read = 0,
               read_token = ?,
               last_sent_at = datetime('now')
           WHERE id = ?`,
          [token, id]
        );
      }

      const from = `"${fromName}" <${fromEmail}>`;

      try {
        const info = await transporter.sendMail({
          from,
          to,
          subject,
          html: htmlWithPixel,
        });

        if (id) db.run(`UPDATE test_emails SET is_sent = 1 WHERE id = ?`, [id]);
        return res.json({ ok: true, to, messageId: info.messageId });
      } catch (e) {
        const invalid = looksLikeInvalidRecipient(e) ? 0 : 1;
        if (id) db.run(`UPDATE test_emails SET is_sent = 0, is_valid = ? WHERE id = ?`, [invalid, id]);
        return res.status(500).json({ ok: false, error: "Send-one failed.", details: String(e?.message || e) });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Send-one failed.", details: String(e?.message || e) });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running: http://localhost:${port}`));

