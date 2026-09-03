<?php
/**
 * ajax/scan_upload.php — receives a scanned PDF from scan.th.com.ge.
 *
 * REFERENCE IMPLEMENTATION. Adapt the database access, storage path and
 * attachment insert to match the portal; the security-relevant parts are the
 * CORS allowlist, the single-use token check, and the file validation.
 *
 * Contract with the scanner:
 *   POST multipart/form-data, no custom headers (so no CORS preflight)
 *     file            the PDF
 *     token           the one-time token
 *     translation_id  the order it belongs to
 *   Responds 200 {"ok":true} on success. On failure, either a 4xx with
 *   {"error":"..."} or a 200 with {"success":false,"error":"..."} - the scanner
 *   understands both, and will not report a success:false body as delivered.
 *   The "error" string is shown to the translator, so write it for them, not
 *   for a log file.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// CORS. The scanner runs on a different origin, so the browser will not let it
// read the response without these. Echo one specific origin rather than "*":
// this endpoint accepts uploads, so anything wider invites other sites to post
// here on a logged-in user's behalf.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = ['https://scan.th.com.ge'];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
}

// The scanner sends no custom headers, so a preflight is not expected.
// Answered anyway, so adding one later does not silently break uploads.
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header('Content-Type: application/json');

function fail(int $status, string $message): never
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'This endpoint only accepts POST.');
}
if (!in_array($origin, ALLOWED_ORIGINS, true)) {
    fail(403, 'Uploads are not accepted from this address.');
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
$token = $_POST['token'] ?? '';
if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
    fail(400, 'The scan link is malformed. Start the scan again from your order.');
}

$pdo = require __DIR__ . '/../includes/db.php';   // adapt: returns a PDO

/*
 * Claim the token and check it in one statement. Doing this as SELECT-then-
 * UPDATE would let two uploads racing on the same token both pass the check.
 * rowCount() tells us whether this request is the one that claimed it.
 */
$claim = $pdo->prepare(
    'UPDATE scan_tokens
        SET used_at = NOW()
      WHERE token = :token
        AND used_at IS NULL
        AND expires_at > NOW()'
);
$claim->execute(['token' => $token]);

if ($claim->rowCount() !== 1) {
    fail(403, 'This scan link has already been used or has expired. Start a new scan from your order.');
}

$row = $pdo->prepare('SELECT translation_id, user_id FROM scan_tokens WHERE token = :token');
$row->execute(['token' => $token]);
$scan = $row->fetch(PDO::FETCH_ASSOC);
if (!$scan) {
    fail(403, 'This scan link is not valid.');
}

// The order comes from the token, never from the request body: otherwise
// anyone holding a valid token could file a document against another order.
$translationId = (int) $scan['translation_id'];
$userId        = (int) $scan['user_id'];

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------
const MAX_BYTES = 40 * 1024 * 1024;

if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    $code = $_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE;
    fail(400, $code === UPLOAD_ERR_INI_SIZE || $code === UPLOAD_ERR_FORM_SIZE
        ? 'The scan is larger than this server accepts. Try Black & white, or a lower resolution.'
        : 'No file arrived. Please try sending the scan again.');
}

$upload = $_FILES['file'];
if ($upload['size'] <= 0 || $upload['size'] > MAX_BYTES) {
    fail(413, 'The scan is too large. Try Black & white, or a lower resolution.');
}

// Trust the bytes, not the declared type: the client controls both the
// filename and the Content-Type of a multipart part.
$handle = fopen($upload['tmp_name'], 'rb');
$magic  = $handle ? fread($handle, 5) : '';
if ($handle) {
    fclose($handle);
}
if ($magic !== '%PDF-') {
    fail(415, 'That file is not a PDF.');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
$dir = sprintf('%s/uploads/translations/%d', dirname(__DIR__), $translationId);
if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
    fail(500, 'The scan could not be saved. Please contact support.');
}

// Generated name, not the client's: never let an uploaded string decide a path.
$filename = sprintf('scan-%s-%s.pdf', date('Ymd-His'), bin2hex(random_bytes(4)));
$path     = $dir . '/' . $filename;

if (!move_uploaded_file($upload['tmp_name'], $path)) {
    fail(500, 'The scan could not be saved. Please contact support.');
}
chmod($path, 0644);

$insert = $pdo->prepare(
    'INSERT INTO translation_files (translation_id, user_id, filename, path, bytes, source, created_at)
     VALUES (:translation_id, :user_id, :filename, :path, :bytes, :source, NOW())'
);
$insert->execute([
    'translation_id' => $translationId,
    'user_id'        => $userId,
    'filename'       => $filename,
    'path'           => sprintf('uploads/translations/%d/%s', $translationId, $filename),
    'bytes'          => filesize($path) ?: $upload['size'],
    'source'         => 'scanner',
]);

echo json_encode([
    'ok'             => true,
    'translation_id' => $translationId,
    'filename'       => $filename,
]);
