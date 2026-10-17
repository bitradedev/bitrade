// Images are displayed by the browser. Never fetch a project-supplied URL from
// the trading server or treat the presence of a logo as safety evidence.
export function tokenLogo(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value))
    return null;
  let source = value;
  if (/^ipfs:\/\//i.test(source)) {
    const path = source.replace(/^ipfs:\/\/(?:ipfs\/)?/i, '');
    if (!/^[a-zA-Z0-9]{32,128}(?:[/?#]|$)/.test(path)) return null;
    source = 'https://ipfs.io/ipfs/' + path;
  }
  try {
    const url = new URL(source),
      host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !host.includes('.') ||
      /^(?:\d|\[)/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(host)
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
