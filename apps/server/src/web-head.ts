/**
 * The web app's `index.html` names its preview image and canonical address as
 * site-relative paths, because a build doesn't know which instance will serve
 * it. Link unfurlers (Slack, X, LinkedIn, iMessage) ignore relative URLs, so
 * the server makes them absolute with its PUBLIC_URL before sending the page.
 * docs/operations.md, "Link previews and search engines".
 */
export function withPublicUrl(html: string, publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return html
    .replace(/((?:property="og:(?:image|url)"|name="twitter:image") content=")\//g, `$1${base}/`)
    .replace(/("(?:url|image)": ")\//g, `$1${base}/`);
}
