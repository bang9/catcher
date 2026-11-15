// The website that hands out registration links (https://<host>/r#<code>) and serves the app-link files
// (apple-app-site-association, assetlinks.json). Change the address here only: app.config.ts reads it for iOS
// associated domains and the Android app-link filter, and the link handler accepts registration links from this host.
export const SITE_URL = 'https://catcher.bang9.dev';

export const SITE_HOST = SITE_URL.replace(/^https:\/\//, '').replace(/[/:].*$/, '');
