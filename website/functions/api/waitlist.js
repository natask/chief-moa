// POST /api/waitlist
// Stores a signup in D1, then sends a confirmation email via Resend (best effort).
// The signup is recorded even if email is not configured yet, so nothing is lost.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const email = String(payload?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json(400, { error: "Enter a valid email address." });
  }

  const now = new Date().toISOString();
  const source = "website";
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";

  if (!env.DB) {
    if (isLocalRequest(request)) {
      return json(200, {
        ok: true,
        emailed: false,
        stored: false,
        message: "You are on the list. We will keep in touch.",
      });
    }
    return json(500, { error: "Waitlist storage is not configured." });
  }

  // Store the signup. Duplicate emails are ignored, not errors.
  try {
    await env.DB.prepare(
      `INSERT INTO waitlist (email, created_at, source, ip)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(email) DO NOTHING`
    )
      .bind(email, now, source, ip)
      .run();
  } catch (err) {
    return json(500, { error: "Could not save your email. Try again." });
  }

  // Send the confirmation email. Best effort: never fail the signup over it.
  let emailed = false;
  if (env.RESEND_API_KEY && env.RESEND_FROM) {
    emailed = await sendConfirmation(env, email).catch(() => false);
  }

  return json(200, {
    ok: true,
    emailed,
    message: emailed
      ? "You are on the list. Check your inbox for a confirmation."
      : "You are on the list. We will keep in touch.",
  });
}

async function sendConfirmation(env, to) {
  const from = env.RESEND_FROM; // e.g. "A.G. <hello@yourdomain.com>"
  const replyTo = env.RESEND_REPLY_TO || undefined;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject: "You're on the A.G. waitlist",
      text: confirmationText(),
      html: confirmationHtml(),
    }),
  });

  return res.ok;
}

function isLocalRequest(request) {
  try {
    const url = new URL(request.url);
    return url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
  } catch {
    return false;
  }
}

function confirmationText() {
  return [
    "Thanks for hopping on the waitlist.",
    "",
    "A.G. is an interactive voice agent, wherever you are. You speak, it does the work, you stay in control.",
    "",
    "We're building it right now. We'll keep in touch as we open up access.",
    "",
    "— Natnael Kahssay",
  ].join("\n");
}

function confirmationHtml() {
  return `<!DOCTYPE html>
<html><body style="margin:0;background:#F4F2EA;font-family:Georgia,'Times New Roman',serif;color:#191B1E">
  <div style="max-width:520px;margin:0 auto;padding:48px 28px">
    <p style="font-family:monospace;font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#7A7D84;margin:0 0 24px">A.G.</p>
    <h1 style="font-size:34px;font-weight:300;line-height:1.1;margin:0 0 20px">Thanks for hopping on the <span style="color:#E5482B;font-style:italic">waitlist.</span></h1>
    <p style="font-size:17px;line-height:1.6;margin:0 0 16px">A.G. is an interactive voice agent, wherever you are. You speak, it does the work, you stay in control.</p>
    <p style="font-size:17px;line-height:1.6;margin:0 0 28px">We're building it right now. We'll keep in touch as we open up access.</p>
    <p style="font-family:monospace;font-size:13px;color:#7A7D84;margin:0">— Natnael Kahssay</p>
  </div>
</body></html>`;
}

// Health/debug for GET so the route is reachable.
export async function onRequestGet() {
  return json(405, { error: "Use POST to join the waitlist." });
}
