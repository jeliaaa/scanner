<?php
/**
 * Portal side: mint a one-time token and render the "Scan" button.
 *
 * REFERENCE IMPLEMENTATION. Drop this next to the existing "Upload" control on
 * the order screen. The token is minted server-side per click-through, so a URL
 * that leaks from browser history is useless within the hour.
 *
 * Schema this expects:
 *
 *   CREATE TABLE scan_tokens (
 *     token          CHAR(64)  NOT NULL PRIMARY KEY,
 *     translation_id INT       NOT NULL,
 *     user_id        INT       NOT NULL,
 *     expires_at     DATETIME  NOT NULL,
 *     used_at        DATETIME  NULL,
 *     created_at     DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
 *     INDEX (translation_id),
 *     INDEX (expires_at)
 *   );
 */

declare(strict_types=1);

const SCANNER_URL   = 'https://scan.th.com.ge/';
const UPLOAD_URL    = 'https://my.tarjimnebi.ge/ajax/scan_upload.php';
const TOKEN_MINUTES = 30;

/**
 * Issue a scan link for one order. Call this when rendering the button, not
 * once per page-load-and-cache: each link should be good for a single upload.
 */
function scan_link(PDO $pdo, int $translationId, int $userId, string $orderLabel): string
{
    // 32 bytes from a CSPRNG. random_bytes throws rather than silently
    // returning weak output, which is the behaviour you want here.
    $token = bin2hex(random_bytes(32));

    $pdo->prepare(
        'INSERT INTO scan_tokens (token, translation_id, user_id, expires_at)
         VALUES (:token, :translation_id, :user_id, DATE_ADD(NOW(), INTERVAL :minutes MINUTE))'
    )->execute([
        'token'          => $token,
        'translation_id' => $translationId,
        'user_id'        => $userId,
        'minutes'        => TOKEN_MINUTES,
    ]);

    return SCANNER_URL . '?' . http_build_query([
        'upload_to'      => UPLOAD_URL,
        'token'          => $token,
        'translation_id' => $translationId,
        'label'          => $orderLabel,
        'return_to'      => sprintf('https://my.tarjimnebi.ge/orders/%d', $translationId),
    ]);
}

// ---------------------------------------------------------------------------
// Render — alongside the existing upload control
// ---------------------------------------------------------------------------
$href = scan_link($pdo, $translation['id'], $currentUser['id'], 'Order ' . $translation['reference']);
?>

<a href="<?= htmlspecialchars($href, ENT_QUOTES) ?>"
   target="_blank"
   rel="noopener noreferrer"
   class="btn btn-secondary">
  Scan with camera
</a>

<?php
/*
 * Housekeeping: clear out spent and expired tokens. Run from the same cron that
 * handles other cleanup rather than on every page load.
 *
 *   DELETE FROM scan_tokens
 *    WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)
 *       OR used_at    < DATE_SUB(NOW(), INTERVAL 1 DAY);
 */
