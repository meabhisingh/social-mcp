import { createHmac, randomBytes } from "node:crypto";

export type OAuth1Material = {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  nonce?: string;
  timestamp?: string;
  /** application/x-www-form-urlencoded body parameters. Multipart and JSON bodies are excluded. */
  bodyParams?: Record<string, string>;
};

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

export function oauth1AuthorizationHeader(method: string, rawUrl: string, material: OAuth1Material): string {
  const url = new URL(rawUrl);
  const oauth: Record<string, string> = {
    oauth_consumer_key: material.consumerKey,
    oauth_nonce: material.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: material.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: material.token,
    oauth_version: "1.0",
  };

  const pairs: Array<{ key: string; value: string }> = [];
  const push = (key: string, value: string) => {
    pairs.push({ key: encodeRfc3986(key), value: encodeRfc3986(value) });
  };

  for (const [key, value] of Object.entries(oauth)) push(key, value);
  for (const [key, value] of url.searchParams) push(key, value);
  for (const [key, value] of Object.entries(material.bodyParams ?? {})) push(key, value);

  pairs.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    if (left.value < right.value) return -1;
    if (left.value > right.value) return 1;
    return 0;
  });

  const parameterString = pairs.map((pair) => `${pair.key}=${pair.value}`).join("&");
  const baseUrl = `${url.origin}${url.pathname}`;
  const baseString = [
    method.toUpperCase(),
    encodeRfc3986(baseUrl),
    encodeRfc3986(parameterString),
  ].join("&");
  const signingKey = `${encodeRfc3986(material.consumerSecret)}&${encodeRfc3986(material.tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerPairs: Record<string, string> = { ...oauth, oauth_signature: signature };
  const header = Object.keys(headerPairs)
    .sort()
    .map((key) => `${encodeRfc3986(key)}="${encodeRfc3986(headerPairs[key] ?? "")}"`)
    .join(", ");
  return `OAuth ${header}`;
}
