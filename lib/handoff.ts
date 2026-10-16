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

/** One document the portal wants a scan for. */
export interface HandoffDocument {
  /** The portal's own id, echoed back as `document_id` with the upload. */
  id: number;
  /** Shown to the translator and used to name the PDF. */
  label: string;
}

/** A sanity bound, not a business rule: a link asking for more is almost surely malformed. */
const MAX_DOCUMENTS = 20;
const MAX_LABEL = 80;

export interface Handoff {
  /** Absolute URL the finished PDF is POSTed to. */
  uploadTo: string;
  /**
   * The documents this order wants scanned, or null for the original
   * one-document link. Only ever used for names and ordering: the portal alone
   * decides which documents a token may fill.
   */
  documents: HandoffDocument[] | null;
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

/** Returns the documents, or a message saying what is wrong with the list. */
function parseDocuments(raw: string): HandoffDocument[] | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "The list of documents in the link is not valid.";
  }

  if (!Array.isArray(value) || value.length === 0) return "The link lists no documents to scan.";
  if (value.length > MAX_DOCUMENTS) return `The link lists more than ${MAX_DOCUMENTS} documents.`;

  const seen = new Set<number>();
  const documents: HandoffDocument[] = [];

  for (const [i, entry] of value.entries()) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return "A document in the link has no valid id.";
    }
    if (seen.has(id)) return "The link lists the same document twice.";
    seen.add(id);

    const text = (entry as { label?: unknown }).label;
    // Control characters stripped, and length capped: the label ends up in the
    // header and in a file name, so it is treated as untrusted text.
    const label = (typeof text === "string" ? text : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL);
    documents.push({ id, label: label || `Document ${i + 1}` });
  }

  return documents;
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

  const rawDocuments = params.get("documents");
  let documents: HandoffDocument[] | null = null;
  if (rawDocuments !== null) {
    const parsed = parseDocuments(rawDocuments);
    if (typeof parsed === "string") return { status: "rejected", reason: parsed };
    documents = parsed;
  }

  return {
    status: "ready",
    handoff: {
      uploadTo: target.toString(),
      documents,
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
  filename: string,
  /** Which portal document this PDF is for; omitted for a one-document link. */
  documentId?: number
): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("file", pdf, filename);
  form.append("token", handoff.token);
  if (handoff.translationId) form.append("translation_id", handoff.translationId);
  if (documentId !== undefined) form.append("document_id", String(documentId));

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
