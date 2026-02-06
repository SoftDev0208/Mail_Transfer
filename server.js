import express from "express";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import crypto from "crypto";
import multer from "multer";
import { ok } from "assert";

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

// ---- helpers ----
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function uniqCid() {
    return crypto.randomBytes(10).toString("hex") + "@inline";
}
function convertDataUriImagesToCid(html) {
    const dom = new JSDOM(`<body>${html}</body>`);
    const doc = dom.window.document;

    const attachments = [];
    for (const img of Array.from(doc.querySelectorAll("img"))) {
        const src = img.getAttribute("src") || "";
        if (!src.startsWith("data:image/")) continue;

        const match = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!match) continue;

        const mime = match[1];
        const b64 = match[2];
        const buf = Buffer.from(b64, "base64");

        const cid = uniqCid();
        attachments.push({
            filename: `inline.${mime.split("/")[1] || "png"}`,
            content: buf,
            contentType: mime,
            cid,
        });

        img.setAttribute("src", `cid:${cid}`);
    }
    return { html: doc.body.innerHTML, attachments };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB, change if needed
});


// ---- Nodemailer transporter (your email will send) ----
// const transporter = nodemailer.createTransport({
//     host: process.env.SMTP_HOST,
//     port: Number(process.env.SMTP_PORT),
//     secure: process.env.SMTP_SECURE === "true",
//     auth: {
//         user: process.env.SMTP_USER,
//         pass: process.env.SMTP_PASS,
//     },
// });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'kamosmbatyan0729@gmail.com',       // Replace with your Gmail
        pass: 'pdpi rhuc clzl qcxg',         // Use App Password if 2FA enabled
    },
    tls: {
        rejectUnauthorized: false // allows self-signed certs
    }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- IMPORTANT: pick the right column from your table `email` ----
// If your table is like: CREATE TABLE email (email TEXT);
// then this query is correct.
const RECIPIENTS_QUERY = `
  SELECT
    email as addr
  FROM test_emails
`;
// If your column is named differently, change above, e.g.
// SELECT address as addr FROM email
// SELECT mail as addr FROM email

// List recipients (optional endpoint for UI)
app.get("/api/recipients", (req, res) => {
    db.all(RECIPIENTS_QUERY, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "DB read failed.", details: String(err) });

        const recipients = Array.from(
            new Set((rows || []).map(r => String(r.addr || "").trim()).filter(isValidEmail))
        );

        res.json({ ok: true, recipients });
    });
});

// Send email to everyone in table `email`
app.post("/api/send", upload.single("template"), async (req, res) => {
  try {
    const subject = String(req.body.subject || "").trim();
    const mode = req.body.mode === "bcc" ? "bcc" : "individual";

    if (!subject) return res.status(400).json({ error: "Subject is required." });
    if (!req.file) return res.status(400).json({ error: "HTML file is required (field name: template)." });

    // Read uploaded HTML file content
    const rawHtml = req.file.buffer.toString("utf-8");
    if (!rawHtml || rawHtml.trim().length < 20) {
      return res.status(400).json({ error: "HTML file looks empty." });
    }

    // Load recipients from DB
    db.all(RECIPIENTS_QUERY, [], async (err, rows) => {
      if (err) return res.status(500).json({ error: "DB read failed.", details: String(err) });

      const recipients = Array.from(
        new Set((rows || []).map(r => String(r.addr || "").trim()).filter(isValidEmail))
      );

      if (recipients.length === 0) {
        return res.status(400).json({ error: "No valid emails found in database." });
      }

      // Convert inline base64 <img src="data:image/..."> to CID attachments (better inbox rendering)
      const converted = convertDataUriImagesToCid(rawHtml);

      const from = `"${process.env.FROM_NAME || "Mailer"}" <${process.env.SMTP_USER}>`;

      if (mode === "bcc") {
        const info = await transporter.sendMail({
          from,
          to: process.env.SMTP_USER,
          bcc: recipients,
          subject,
          html: converted.html,
          attachments: converted.attachments,
        });

        return res.json({
          ok: true,
          mode: "bcc",
          accepted: recipients.length,
          messageId: info.messageId,
        });
      }

      // Individual mode (recommended)
      const results = [];
      for (const to of recipients) {
        try {
          const info = await transporter.sendMail({
            from,
            to,
            subject,
            html: converted.html,
            attachments: converted.attachments,
          });
          await sleep(2000);
          results.push({ to, ok: true, messageId: info.messageId });
        } catch (e) {
          results.push({ to, ok: false, error: String(e?.message || "send failed") });
        }
      }

      const sent = results.filter(r => r.ok).length;
      return res.json({ ok: true, mode: "individual", total: recipients.length, sent, results });
    });
  } catch (e) {
    return res.status(500).json({ error: "Send failed.", details: String(e) });
  }
});

app.post("/api/send-one", upload.single("template"), async (req, res) => {
  try {
    const to = String(req.body.to || "").trim();
    const subject = String(req.body.subject || "").trim();

    if (!to) return res.status(400).json({ error: "Recipient (to) is required." });
    if (!isValidEmail(to)) return res.status(400).json({ error: "Invalid recipient email." });
    if (!subject) return res.status(400).json({ error: "Subject is required." });
    if (!req.file) return res.status(400).json({ error: "HTML file is required (field name: template)." });

    const rawHtml = req.file.buffer.toString("utf-8");
    if (!rawHtml || rawHtml.trim().length < 20) {
      return res.status(400).json({ error: "HTML file looks empty." });
    }

    const converted = convertDataUriImagesToCid(rawHtml);

    const from = `"${process.env.FROM_NAME || "Mailer"}" <${process.env.SMTP_USER}>`;

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html: converted.html,
      attachments: converted.attachments,
    });

    return res.json({ ok: true, to, messageId: info.messageId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Send-one failed.", details: String(e?.message || e) });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running: http://localhost:${port}`));
