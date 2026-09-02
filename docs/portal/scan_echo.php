<?php
/**
 * ajax/scan_echo.php — a throwaway receiver for testing the wire only.
 *
 * Accepts any token and any order, saves the PDF to a temp folder, and reports
 * what it received. Its whole purpose is to prove that CORS, the preflight and
 * the multipart body all work before scan_upload.php and the token table exist,
 * so that when something fails you know which half is at fault.
 *
 * DELETE THIS ONCE scan_upload.php WORKS. It validates nothing and will accept
 * an upload from anyone who finds the URL.
 */

declare(strict_types=1);

const ALLOWED_ORIGINS = ['https://scan.th.com.ge'];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: X-Scan-Token, Content-Type');
    header('Access-Control-Max-Age: 86400');
}

// The scanner sends X-Scan-Token, which makes the POST non-simple, so the
// browser asks permission first. If this block is missing, the upload fails
// with a CORS error and the request below never runs.
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header('Content-Type: application/json');

$dir = sys_get_temp_dir() . '/scan-echo';
if (!is_dir($dir)) {
    mkdir($dir, 0775, true);
}

$saved = null;
$bytes = 0;
if (isset($_FILES['file']) && $_FILES['file']['error'] === UPLOAD_ERR_OK) {
    $saved = sprintf('%s/%s.pdf', $dir, date('Ymd-His'));
    move_uploaded_file($_FILES['file']['tmp_name'], $saved);
    $bytes = filesize($saved) ?: 0;
}

echo json_encode([
    'ok'             => $saved !== null,
    'origin'         => $origin,
    'method'         => $_SERVER['REQUEST_METHOD'] ?? null,
    'header_token'   => $_SERVER['HTTP_X_SCAN_TOKEN'] ?? null,
    'body_token'     => $_POST['token'] ?? null,
    'translation_id' => $_POST['translation_id'] ?? null,
    'saved_to'       => $saved,
    'bytes'          => $bytes,
    'looks_like_pdf' => $saved !== null && file_get_contents($saved, false, null, 0, 5) === '%PDF-',
], JSON_PRETTY_PRINT);
