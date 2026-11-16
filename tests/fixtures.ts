const TOKEN = "fixture-token".repeat(4);
export const UUID = "9b00c97f-f841-4625-b970-719534722e9f";
export const MAIN = {
  protocol: "vless",
  settings: { address: "main.example.com", encryption: "none", id: UUID, port: 443 },
  streamSettings: { network: "xhttp", security: "tls", xhttpSettings: { path: "/test" } },
  tag: "provider-main",
};
export const BRIDGE = {
  protocol: "vless",
  settings: { address: "exit.example.com", encryption: "none", id: UUID, port: 443 },
  streamSettings: { network: "raw", security: "tls" },
};
export const LINK = `vless://${UUID}@main.example.com:443?type=raw&security=tls#Fixture`;

export function env(): Record<string, unknown> {
  return {
    EXIT_OUTBOUND: JSON.stringify(BRIDGE),
    SOURCES: [
      { id: "a", urlSecret: "UPSTREAM_A" },
      { id: "b", urlSecret: "UPSTREAM_B" },
    ],
    SUB_ACCESS_TOKEN: TOKEN,
    UPSTREAM_A: "https://one.example.com/secret-a",
    UPSTREAM_B: "https://two.example.com/secret-b",
  };
}

export function request(hwid = "fixture-device", token = TOKEN): Request {
  return new Request(`https://worker.example.com/sub/${token}`, {
    headers: {
      Authorization: "Bearer must-not-forward",
      Cookie: "must-not-forward",
      "User-Agent": "Happ/example",
      "X-HWID": hwid,
    },
  });
}
