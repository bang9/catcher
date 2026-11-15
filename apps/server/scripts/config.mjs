// The deploy config: wrangler.jsonc with this deployment's values filled in from the environment, so the public repo
// holds no account-specific values and anyone can deploy their own relay from it.
//   D1_DATABASE_ID          required — the D1 database id (wrangler d1 create catcher)
//   RELAY_DOMAIN            optional — custom domain for the relay (default api.catcher.bang9.dev, the public one)
//   RELAY_PLACEMENT_REGION  optional — run the Worker near a cloud region, e.g. the D1 primary's (aws:ap-northeast-3)
export function deployConfig(text, env) {
  const id = env.D1_DATABASE_ID;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('D1_DATABASE_ID is missing or malformed');
  let out = text.replace('00000000-0000-0000-0000-000000000000', id);
  if (out === text) throw new Error('placeholder database id not found in wrangler.jsonc');
  const domain = env.RELAY_DOMAIN;
  if (domain) {
    if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error('RELAY_DOMAIN must be a bare host name');
    out = out.replace('"pattern": "api.catcher.bang9.dev"', `"pattern": "${domain}"`);
  }
  const region = env.RELAY_PLACEMENT_REGION;
  if (region) {
    if (!/^[a-z]+:[a-z0-9-]+$/.test(region)) throw new Error('RELAY_PLACEMENT_REGION looks like aws:ap-northeast-3');
    out = out.replace(
      '"workers_dev": false,',
      `"workers_dev": false,\n  "placement": { "mode": "targeted", "region": "${region}" },`,
    );
  }
  return out;
}
