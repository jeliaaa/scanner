/**
 * Portal hand-off: scan here, deliver the PDF straight back to the system that
 * asked for it, instead of downloading a file the user then has to re-upload.
 *
 * The portal opens this app with the destination in the query string:
 *
 *   /?upload_to=https://app.example.com/ajax/scan_upload.php
 *    &token=<one-time>&translation_id=456
 *
 * Because `upload_to` is attacker-controllable, it is checked against an
 * allowlist before anything is ever sent to it. Without that check, a link like
 * `?upload_to=https://evil.example/collect` would turn this app into a document
 * exfiltration tool aimed at whoever was sent the link. The allowlist fails
 * closed: with none configured, hand-off is refused rather than trusted.
 */

export interface Handoff {
  /** Absolute URL the finished PDF is POSTed to. */
  uploadTo: string;
  /** One-time credential minted by the portal; opaque to us. */
  token: string;
  /** Order this scan belongs to, echoed back so the portal can file it. */
  translationId: string | null;
  /** Where to send the user once the upload succeeds. */
  returnTo: string | null;
  /** Human-readable order reference, shown in the UI for reassurance. */
  label: string | null;
}

export type HandoffResult =
  | { status: "none" }
  | { status: "ready"; handoff: Handoff }
  | { status: "rejected"; reason: string };

function allowedOrigins(): string[] {
  return (process.env.NEXT_PUBLIC_UPLOAD_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function readHandoff(search: string): HandoffResult {
  const params = new URLSearchParams(search);
  const uploadTo = params.get("upload_to");
  const token = params.get("token");

  if (!uploadTo && !token) return { status: "none" };
  if (!uploadTo || !token) {
    return { status: "rejected", reason: "The link is missing its upload address or token." };
  }

  let target: URL;
  try {
    target = new URL(uploadTo);
  } catch {
    return { status: "rejected", reason: "The upload address in the link is not a valid URL." };
  }

  const isLocal = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (target.protocol !== "https:" && !isLocal) {
    return {
      status: "rejected",
      reason: "The upload address must use https. Scanned documents are not sent over plain http.",
    };
  }

  const allowed = allowedOrigins();
  if (allowed.length === 0) {
    return {
      status: "rejected",
      reason:
        "No upload destinations are configured on this server, so the link cannot be trusted. " +
        "Set NEXT_PUBLIC_UPLOAD_ORIGINS and rebuild.",
    };
  }
  if (!allowed.includes(target.origin)) {
    return {
      status: "rejected",
      reason: `${target.origin} is not an approved destination for scanned documents.`,
    };
  }

  return {
    status: "ready",
    handoff: {
      uploadTo: target.toString(),
      token,
      translationId: params.get("translation_id"),
      returnTo: params.get("return_to"),
      label: params.get("label"),
    },
  };
}

export interface UploadOutcome {
  ok: boolean;
  status: number;
  message: string;
}

/**
 * POST the finished PDF to the portal.
 *
 * Deliberately sent with no custom headers. A multipart POST carrying only
 * form fields is a CORS "simple request", so the browser sends it straight
 * out. Adding something like an X-Scan-Token header would instead provoke an
 * OPTIONS preflight, and any endpoint that does not answer that fails with an
 * opaque network error before the upload is even attempted. The token rides in
 * the body, which every server-side framework can read without extra work.
 *
 * The receiving endpoint still has to return Access-Control-Allow-Origin, or
 * the browser will not let us read the reply.
 */
export async function uploadToPortal(
  handoff: Handoff,
  pdf: Blob,
  filename: string
): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("file", pdf, filename);
  form.append("token", handoff.token);
  if (handoff.translationId) form.append("translation_id", handoff.translationId);

  let response: Response;
  try {
    response = await fetch(handoff.uploadTo, {
      method: "POST",
      body: form,
      // Keeps the token out of the Referer header on the portal's side.
      referrerPolicy: "no-referrer",
      // No cookies: the token is the only credential, and sending ambient
      // session cookies cross-site would be a CSRF footgun for the portal.
      credentials: "omit",
    });
  } catch {
    return {
      ok: false,
      status: 0,
      message:
        "Could not reach the portal. It is offline, the address is wrong, or it did not send " +
        "the CORS header that lets this site talk to it.",
    };
  }

  if (response.ok) {
    // A 200 is not proof of success: endpoints commonly report a rejected
    // upload as {"success":false,"error":"..."} with an OK status. Treating
    // the status alone as the answer would tell the user their scan was filed
    // when it was thrown away.
    try {
      const body = await response.clone().json();
      if (body && (body.success === false || body.ok === false)) {
        return {
          ok: false,
          status: response.status,
          message: body.error || body.message || "The portal rejected the scan.",
        };
      }
    } catch {
      /* not JSON, or empty: a 2xx with no complaint counts as success */
    }
    return { ok: true, status: response.status, message: "Delivered to the portal." };
  }

  // Surface the portal's own wording where it gives any; it knows why better
  // than we do (expired token, wrong order, file too large).
  let detail = `${response.status} ${response.statusText}`.trim();
  try {
    const text = (await response.text()).trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        detail = parsed.error || parsed.message || detail;
      } catch {
        detail = text.slice(0, 300);
      }
    }
  } catch {
    /* keep the status line */
  }

  return { ok: false, status: response.status, message: detail };
}
