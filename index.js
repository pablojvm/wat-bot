import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getSession, saveSession, resetSession, insertLead } from "./db.js";

dotenv.config();

const app = express();
app.use(express.json());

/* ------------------------------ Rutas seguras ----------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENTS_PATH = path.join(__dirname, "clients.json");

/* ----------------------------- OpenAI client ----------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------- Client configs ---------------------------- */
const clients = JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf-8"));

function getClientConfig(phoneNumberId) {
  return (
    clients[phoneNumberId] || {
      id: "default",
      systemPrompt: "Eres un asistente útil. Responde breve y en español.",
      model: "gpt-4o-mini",
      temperature: 0.4,
      capabilities: {},
    }
  );
}

function isEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((text || "").trim());
}

/* ------------------------------ Meta webhook ----------------------------- */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ------------------------------ WhatsApp send ---------------------------- */
async function sendWhatsAppText(phoneNumberId, to, text) {
  const url = `https://graph.facebook.com/v24.0/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.META_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* -------------------------------- OpenAI -------------------------------- */
async function replyWithAI(userText, client) {
  const resp = await openai.chat.completions.create({
    model: client.model || "gpt-4o-mini",
    temperature: client.temperature ?? 0.4,
    messages: [
      { role: "system", content: client.systemPrompt || "" },
      { role: "user", content: userText || "" },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "No he podido responder.";
}

/* ------------------------------- Webhook POST ---------------------------- */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const client = getClientConfig(phoneNumberId);

    const msg = value?.messages?.[0];
    if (!msg) return;

    // Solo texto
    if (msg.type !== "text") {
      console.log("Ignorado (no texto):", msg.type);
      return;
    }

    // Dedupe
    const msgId = msg.id;
    globalThis.__seenMsgIds = globalThis.__seenMsgIds || new Set();
    if (globalThis.__seenMsgIds.has(msgId)) return;
    globalThis.__seenMsgIds.add(msgId);

    const from = msg.from; // sin +
    const userText = (msg?.text?.body || "").trim();

    console.log(`[${client.id}] phone=${phoneNumberId} de=${from} text="${userText}"`);

    // Reset rápido para pruebas (manda "reset" por WhatsApp)
    if (userText.toLowerCase() === "reset") {
      await resetSession(client.id, from);
      await sendWhatsAppText(phoneNumberId, from, "Sesión reiniciada ✅");
      return;
    }

    const caps = client.capabilities || {};

    /* ------------------------------ 1) HANDOFF ------------------------------ */
    if (caps.handoff?.enabled) {
      const kws = caps.handoff.keywords || [];
      const wantsHuman = kws.some((k) =>
        userText.toLowerCase().includes(String(k).toLowerCase())
      );
      if (wantsHuman) {
        await sendWhatsAppText(
          phoneNumberId,
          from,
          caps.handoff.message || "Te paso con una persona."
        );
        return;
      }
    }

    /* -------------------------------- 2) FAQ -------------------------------- */
    if (caps.faq?.enabled) {
      const items = caps.faq.items || [];
      const hit = items.find((it) =>
        userText.toLowerCase().includes(String(it.q || "").toLowerCase())
      );
      if (hit?.a) {
        await sendWhatsAppText(phoneNumberId, from, hit.a);
        return;
      }
    }

    /* --------------------------- 3) LEAD CAPTURE ---------------------------- */
    if (caps.leadCapture?.enabled) {
      const fields = caps.leadCapture.fields || [];

      // cargamos sesión (persistente)
      let lead = await getSession(client.id, from);

      // name
      if (fields.includes("name") && !lead.name) {
        if (userText.length <= 40 && !isEmail(userText)) {
          lead.name = userText;
          await saveSession(client.id, from, lead);
        } else {
          await sendWhatsAppText(phoneNumberId, from, "¿Cómo te llamas?");
          return;
        }
      }

      // email
      if (fields.includes("email") && !lead.email) {
        if (isEmail(userText)) {
          lead.email = userText;
          await saveSession(client.id, from, lead);
        } else {
          await sendWhatsAppText(phoneNumberId, from, "¿Cuál es tu email?");
          return;
        }
      }

      // need
      if (fields.includes("need") && !lead.need) {
        if (!isEmail(userText) && userText.length > 1) {
          lead.need = userText;
          await saveSession(client.id, from, lead);
        } else {
          await sendWhatsAppText(phoneNumberId, from, "Cuéntame brevemente qué necesitas.");
          return;
        }
      }

      const done =
        (!fields.includes("name") || lead.name) &&
        (!fields.includes("email") || lead.email) &&
        (!fields.includes("need") || lead.need);

      if (done && !lead._confirmed) {
        lead._confirmed = true;
        await saveSession(client.id, from, lead);

        await insertLead(client.id, from, {
          name: lead.name,
          email: lead.email,
          need: lead.need,
        });

        await sendWhatsAppText(
          phoneNumberId,
          from,
          caps.leadCapture.confirmMessage || "¡Gracias! Lo tengo."
        );
        return;
      }
    }

    /* --------------------------------- IA ---------------------------------- */
    const aiText = await replyWithAI(userText, client);
    await sendWhatsAppText(phoneNumberId, from, aiText);
  } catch (e) {
    console.error("Error procesando webhook:", e?.response?.data || e.message);
  }
});

/* --------------------------------- Health -------------------------------- */
app.get("/", (_req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log(`Webhook escuchando en http://localhost:${process.env.PORT || 3000}`);
});