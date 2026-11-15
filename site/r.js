// Enrollment link page. The code lives only in the URL fragment, which browsers never send to a server. This script
// reads it, checks its shape, shows it and offers to open the app. It makes no network requests.
(() => {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  /** Crockford base32, the same normalisation the CLI and app use: upper-case, drop spaces and dashes, O→0, I/L→1. */
  const parse = (raw) => {
    let text = raw;
    try {
      text = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const chars = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (chars.length !== 16) return null;
    for (const c of chars) if (!ALPHABET.includes(c)) return null;
    return chars.match(/.{4}/g).join('-');
  };

  const show = () => {
    const code = parse(location.hash.slice(1));
    if (!code) return;
    // keep the code out of the address bar and browser history from here on
    history.replaceState(null, '', location.pathname);

    document.getElementById('code').textContent = code;
    document.getElementById('no-code').hidden = true;
    document.getElementById('has-code').hidden = false;

    // Android: an intent pinned to our package, so no other app can receive the code; never navigate on our own.
    // iOS: no custom scheme (any app can claim one). With the app installed, the verified universal link opens the
    // app before this page loads; otherwise the person types or pastes the code.
    if (/Android/.test(navigator.userAgent)) {
      const open = document.getElementById('open');
      open.setAttribute(
        'href',
        `intent://enroll?code=${encodeURIComponent(code)}#Intent;scheme=catcher;package=com.bang9dev.catcher;end`,
      );
      open.hidden = false;
    }
  };

  show();
})();
