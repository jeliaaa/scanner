# Multi-document orders: changes needed

**Status:** the scanner-side changes below are implemented. The portal side
(token table, `scan_upload.php` taking `document_id`, the Scan button on
multi-document orders) is **not**, and until it is, a `documents=` link will
upload but the portal will ignore the extra `document_id` field.

Today one scan link produces one PDF for one order. An order with several
documents (say four, of three to five pages each) needs one PDF per document,
all delivered from a single trip through the scanner.

## What was checked, and what was not

Checked, in this repo: the scanner code and the reference portal files in
`docs/portal/`.

**Not checked: the real portal code on `app.tarjimnebi.ge`.** It is not in this
repo, so the cause of the missing Scan button below is a diagnosis from the
reference code, not a confirmed finding.

## Why the Scan button is missing on multi-document orders

`docs/portal/scan_button.php` is written for one order with one document:

- It renders a single link from one `$translation['id']` and one
  `$translation['reference']`, "alongside the existing Upload control".
- `scan_link()` mints one token tied to one `translation_id`.

A multi-document order screen most likely shows one upload control per document,
or a different template. The snippet is then never included there, or it runs
without a `$translation` to read. Check these on the portal, in order:

1. View page source on a multi-document order and search for `scan.th.com.ge`.
   Absent means the button is not rendered at all.
2. Look at `scan_tokens` after loading that page. A new row means `scan_link()`
   ran and the template drops the link. No row means the code path is never
   reached.
3. Search the order template for a condition that hides the control when there
   is more than one document (for example `count($documents) === 1`).

**Hostname mismatch to settle.** The docs were changed (commit `f3c8d52`) to say
the portal is `my.tarjimnebi.ge`. The scanner's real `.env.local`, the
`.env.example` and the dev log all use `app.tarjimnebi.ge`, and that is the
host sending the link. If the portal really is `app.`, fix
`docs/portal/README.md` and `scan_button.php` back. If both hosts exist, the
button may only be missing on whichever one lacks the snippet. In either case
`NEXT_PUBLIC_UPLOAD_ORIGINS` must list every origin that sends links.

## Link contract v2

Keep today's parameters. Add one:

```
&documents=[{"id":101,"label":"Passport"},{"id":102,"label":"Birth certificate"}]
```

URL-encoded JSON. The scanner uses `documents` only to show names and order the
list. **The portal never trusts it:** the server alone decides which documents a
token may fill (below), because anyone can edit a URL. With no `documents` parameter the
scanner behaves exactly as it does now, so old links keep working.

## Portal changes

1. **One token per order, one claim per document.** New table:

   ```sql
   CREATE TABLE scan_token_documents (
     token        CHAR(64) NOT NULL,
     document_id  INT      NOT NULL,
     used_at      DATETIME NULL,
     PRIMARY KEY (token, document_id)
   );
   ```

   `scan_link()` takes the order's document list, inserts a row per document,
   and puts the same list in `documents=`.
2. **`scan_upload.php` takes a `document_id`.** Claim it with one conditional
   `UPDATE scan_token_documents SET used_at = NOW() WHERE token = ? AND
   document_id = ? AND used_at IS NULL`, and check `rowCount()`. Keep the token
   check but stop marking the token itself as spent on first use; the token is
   finished when every document row is claimed or it expires. File the PDF
   against that `document_id`, never one taken from the request body.
3. **Token lifetime.** 30 minutes is short for 16 or so pages. Use 90.
4. **Render the Scan button for every order,** one per order not one per
   document, passing all its documents. Do not condition it on document count.
5. **Reply shape.** Return `{"ok":true,"document_id":101}`; keep `error` strings
   written for the translator.

## Scanner changes

No backend change: `/sessions/{id}/export` already exports whichever pages it is
sent, so one call per document works.

1. **State** (`lib/store.ts`): replace `pages[]` with `documents[]`, each
   `{ id, label, pages[], filename }`, plus `activeDocumentId`. On load, migrate
   a stored old `pages[]` into one document.
2. **`lib/handoff.ts`:** parse and validate `documents` (count cap of about 20,
   integer ids, labels trimmed to a sane length). Reject a malformed list the
   same way a bad `upload_to` is rejected.
3. **Camera and review screens:** show the active document's name as a chip
   under the top bar, tap to switch. After Done, offer "Next document: Birth
   certificate". The thumbnail and badge count only the active document.
   Without a `documents` list, a "New document" action still lets a plain scan
   hold several PDFs.
4. **Export sheet** (`components/ExportPanel.tsx`): become a list, one row per
   document with its page count, status (waiting, sending, sent, failed) and a
   Retry. A **Send all** button uploads them one after another. A document with
   no pages is shown as missing, not skipped silently.
5. **Upload** (`uploadToPortal`): send `document_id` in the form body, still no
   custom headers, so it stays a CORS simple request. Keep each document's
   result separately so a failure on the third does not discard the first two.
6. **Fallback:** "Download the PDF instead" downloads each document's PDF in
   turn.
7. **After all sent:** show "Return to your order" once; keep per-document
   failures on screen until resolved.

## Decisions needed from you

- Is every document required, or may some be left without a scan?
- One file per document (this plan), or one merged PDF for the whole order?
- What is a "document" in the portal's data: a row in `translation_files`, a
  child of `translations`, something else? The SQL above uses placeholder names.
- Is the portal `app.` or `my.` (see above)?

## Test checklist

- Single-document link: unchanged behaviour.
- Four documents, 3 to 5 pages each: all four filed against the right documents.
- Reload the scanner mid-way: documents and pages survive.
- Second upload to an already-claimed document is refused with a readable error.
- Token expiring after two of four: those two stay filed, the rest report the
  expiry, and a new link can finish the others.
- Network drop on document three: Retry works without re-scanning.
