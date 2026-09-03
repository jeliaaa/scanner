# Portal hand-off

Lets a translator scan straight into an order: the portal opens the scanner,
the scanner posts the finished PDF back, and the file lands on the order without
anyone downloading and re-uploading it.

```
portal order screen
  │  click "Scan with camera"
  ▼
scan.th.com.ge/?upload_to=…&token=…&translation_id=456
  │  scan, adjust edges, choose a look
  ▼
POST multipart to the portal's ajax/scan_upload.php
  │  token claimed, PDF stored, attached to the order
  ▼
"Sent to the portal" → Return to your order
```

## The link

```
https://scan.th.com.ge/
  ?upload_to=https://my.tarjimnebi.ge/ajax/scan_upload.php
  &token=<64 hex chars>
  &translation_id=456
  &label=Order%20A-1234        (optional, shown to the translator)
  &return_to=https://…/orders/456   (optional, button after success)
```

## The upload

```
POST <upload_to>
Content-Type: multipart/form-data

  file            the PDF
  token           the one-time token
  translation_id  echoed back
```

**No custom headers are sent, on purpose.** A multipart POST carrying only form
fields is a CORS *simple request*, so no `OPTIONS` preflight happens. Add a
header like `X-Scan-Token` and every endpoint that does not answer `OPTIONS`
starts failing with an opaque network error. You still need
`Access-Control-Allow-Origin` on the POST response.

Cookies are deliberately **not** sent (`credentials: omit`) and the referrer is
suppressed. The token is the only credential.

On success reply `200`. On failure either reply 4xx, or reply 200 with
`{"success":false,"error":"..."}` — both are understood, and a 200 whose body
says `success:false` is treated as a failure rather than reported to the user as
a delivered scan. The `error` string is shown to the translator verbatim, so
write it for them ("This scan link has expired, start a new scan from your
order") rather than for a log.

## What you have to do

**1. Scanner side** — set the allowlist and rebuild:

```
NEXT_PUBLIC_UPLOAD_ORIGINS=https://my.tarjimnebi.ge
```

Put it in `.env.local` on the server (or a machine-level environment variable),
then `npm run build` and recycle the `scan` app pool. It is read at build time,
not at start-up.

This is not optional plumbing. `upload_to` arrives in the query string, so
without an allowlist anyone could send a translator a link pointing at their own
server and collect scanned documents. With no allowlist configured the scanner
refuses every hand-off link and says so.

**2. Portal side** — `scan_upload.php` and `scan_button.php` in this folder are
working references. Adapt the database access, storage path and attachment
insert; keep the CORS allowlist, the single-use token claim and the file
validation as they are.

**3. Database** — one table, schema in `scan_button.php`.

## Things that are easy to get wrong

- **Missing `Access-Control-Allow-Origin` on the POST response.** The upload
  itself needs no preflight, but without this header the browser refuses to let
  the scanner read the reply, and it reports the portal as unreachable.
- **`Access-Control-Allow-Origin: *`.** This endpoint accepts uploads. Echo the
  one origin you trust.
- **SELECT then UPDATE on the token.** Two uploads racing on one token would
  both pass. Claim it with a single conditional `UPDATE` and check `rowCount()`.
- **Trusting `translation_id` from the body.** Take it from the token row —
  otherwise a valid token can file a document against someone else's order.
- **Trusting the declared MIME type.** The client sets it. Check the first five
  bytes are `%PDF-`.
- **Using the client's filename.** Generate your own; never let uploaded text
  choose a path.

## Trying it without the portal

The scanner's behaviour can be exercised on its own. With
`NEXT_PUBLIC_UPLOAD_ORIGINS=https://my.tarjimnebi.ge` set, open a link with
those parameters and the header shows which order the scan is bound for, the
export button becomes **Send to portal**, and a **Download the PDF instead**
fallback appears underneath for when the portal is unreachable.

Point `upload_to` at any other origin and the scanner refuses it, names the
origin it rejected, and falls back to ordinary download.
