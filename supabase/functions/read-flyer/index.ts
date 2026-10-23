// read-flyer — reads an event flyer photo and returns event fields to pre-fill a form.
// The photo is never stored. Requires the ANTHROPIC_API_KEY secret.
// POST JSON: { image: "<base64 jpeg/png/webp, no data: prefix>", media_type?: "image/jpeg" }
// Returns: { event: { name, date_text, start_date, end_date, time_text, location, address,
//                     category, description, website, admission }, confidence, notes }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODEL = "claude-haiku-5-5";
const MAX_B64 = 3_500_000; // ~2.6 MB image; the app resizes to ~1600px first
const CATS = ["Music", "Arts & Culture", "Food & Drink", "Outdoors", "Wellness", "Family", "Community", "Sports", "Market", "Other"];

// Light per-instance throttle (the Console spend limit is the real backstop).
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function todayDenver(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const clean = (v: unknown, max: number) => {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, "") + "…";
};
const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "Flyer reading isn't set up yet." }, 503);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) return json({ error: "Too many flyers in a short time. Please try again later." }, 429);

  let body: { image?: string; media_type?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const image = (body.image || "").replace(/^data:[^,]+,/, "");
  const media = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(body.media_type || "") ? body.media_type! : "image/jpeg";
  if (!image || image.length < 1000) return json({ error: "No photo received." }, 400);
  if (image.length > MAX_B64) return json({ error: "That photo is too large." }, 413);

  const today = todayDenver();
  const prompt = `You are reading a photo of an event flyer or poster for a visitor guide to Trinidad, Colorado.
Today's date is ${today} (America/Denver).

Return ONLY a JSON object, no other text, with these keys (use "" when the flyer doesn't say):
{
  "is_event_flyer": true or false,
  "name": "event title",
  "date_text": "dates as a visitor should read them, e.g. 'Sat, Nov 8' or 'Nov 14–16'",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD (same as start_date for a one-day event)",
  "time_text": "SHORT, under 45 characters, e.g. '7 pm' or '10 am – 3 pm' (put extra schedule detail in description)",
  "location": "venue name",
  "address": "street address if printed",
  "category": one of ${JSON.stringify(CATS)},
  "description": "2–3 plain sentences describing the event, using only what the flyer says",
  "website": "URL if printed",
  "admission": "price or 'Free' if printed",
  "confidence": "high", "medium" or "low",
  "notes": "anything the person should double-check, e.g. 'year not printed, assumed 2026'"
}
Rules: if the year is missing, use the next occurrence on or after today. For recurring events (e.g. 'every Friday'), use the next date and say so in notes. Never invent details that are not on the flyer. If this is not an event flyer, set is_event_flyer to false.`;

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2026-10-21", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data: image } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch (e) {
    return json({ error: "Couldn't reach the flyer reader. Try again.", detail: String(e) }, 502);
  }

  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("anthropic error", res.status, JSON.stringify(out).slice(0, 500));
    return json({ error: "The flyer reader had a problem. Try again or fill the form by hand.", status: res.status }, 502);
  }

  const text = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let p: Record<string, unknown> = {};
  try { p = m ? JSON.parse(m[0]) : {}; } catch { /* fall through */ }
  if (!m || !Object.keys(p).length) return json({ error: "Couldn't read that flyer. Try a closer, straighter photo." }, 422);
  if (p.is_event_flyer === false) return json({ error: "That doesn't look like an event flyer." }, 422);

  const start = isoDate(p.start_date);
  let end = isoDate(p.end_date) || start;
  if (end && start && end < start) end = start;
  const cat = CATS.includes(String(p.category)) ? String(p.category) : "";

  return json({
    event: {
      name: clean(p.name, 120),
      date_text: clean(p.date_text, 80),
      start_date: start,
      end_date: end,
      time_text: clean(p.time_text, 60),
      location: clean(p.location, 120),
      address: clean(p.address, 160),
      category: cat,
      description: clean(p.description, 1000),
      website: clean(p.website, 200),
      admission: clean(p.admission, 80),
    },
    confidence: clean(p.confidence, 10) || "medium",
    notes: clean(p.notes, 400),
  });
});
