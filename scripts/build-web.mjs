/**
 * Builds the browser demo into public/.
 *
 * src/web/index.html is authored as a fragment (title, styles, markup,
 * scripts) because that is the shape the artifact host expects. Serving it
 * ourselves means supplying the document skeleton the host would otherwise
 * add, so the same source drives both without being maintained twice.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const fragment = readFileSync('src/web/index.html', 'utf8')

const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${fragment}
</body>
</html>
`

mkdirSync('public', { recursive: true })
writeFileSync('public/index.html', document)
console.log(`public/index.html  ${(document.length / 1024).toFixed(1)}kb`)
