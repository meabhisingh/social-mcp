import assert from "node:assert/strict";
import test from "node:test";
import { oauth1AuthorizationHeader } from "../src/oauth1.js";

test("oauth 1.0a matches the documented signature base", () => {
  const header = oauth1AuthorizationHeader(
    "POST",
    "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    {
      consumerKey: "xvz1evFS4wEEPTGEFPHBog",
      consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
      bodyParams: {
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      },
    },
  );

  assert.equal(
    header.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'),
    true,
  );
  assert.match(header, /^OAuth /);
  assert.match(header, /oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"/);
});
