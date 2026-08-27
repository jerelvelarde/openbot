import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Address4, Address6 } from "ip-address";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type MediaUploadDependencies = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  put?: (input: {
    url: URL;
    address: ResolvedAddress;
    contentType: string;
    bytes: Uint8Array;
  }) => Promise<number>;
};

type IpRange = readonly [base: bigint, prefix: number];

function inRange(value: bigint, [base, prefix]: IpRange, bits: number) {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

const NON_GLOBAL_V4: IpRange[] = [
  [0x00000000n, 8],
  [0x0a000000n, 8],
  [0x64400000n, 10],
  [0x7f000000n, 8],
  [0xa9fe0000n, 16],
  [0xac100000n, 12],
  [0xc0000000n, 24],
  [0xc0000200n, 24],
  [0xc0586300n, 24],
  [0xc0a80000n, 16],
  [0xc6120000n, 15],
  [0xc6336400n, 24],
  [0xcb007100n, 24],
  [0xe0000000n, 4],
  [0xf0000000n, 4],
];

function publicIpv4(value: bigint): boolean {
  return !NON_GLOBAL_V4.some((range) => inRange(value, range, 32));
}

const NON_GLOBAL_V6: IpRange[] = [
  [0n, 128],
  [1n, 128],
  [new Address6("64:ff9b:1::").bigInt(), 48], // local-use NAT64
  [new Address6("100::").bigInt(), 64], // discard-only
  [new Address6("2001::").bigInt(), 23], // reserved/transition/documentation
  [new Address6("2001:db8::").bigInt(), 32], // documentation
  [new Address6("3fff::").bigInt(), 20], // documentation
  [new Address6("5f00::").bigInt(), 16], // segment-routing experiments
  [new Address6("fc00::").bigInt(), 7],
  [new Address6("fe80::").bigInt(), 10],
  [new Address6("fec0::").bigInt(), 10],
  [new Address6("ff00::").bigInt(), 8],
];

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return publicIpv4(new Address4(address).bigInt());
  }
  if (isIP(address) !== 6) return false;
  const value = new Address6(address).bigInt();
  if (NON_GLOBAL_V6.some((range) => inRange(value, range, 128))) return false;

  const high96 = value >> 32n;
  const embeddedV4 = value & 0xffffffffn;
  // IPv4-compatible, IPv4-mapped, and well-known NAT64 addresses inherit the embedded address's
  // classification. The local-use NAT64 prefix is rejected wholesale above.
  if (
    high96 === 0n ||
    high96 === 0xffffn ||
    high96 === 0x0064ff9b0000000000000000n
  ) {
    return publicIpv4(embeddedV4);
  }
  // 6to4 and ISATAP can route to their embedded IPv4 destination.
  if (value >> 112n === 0x2002n) {
    return publicIpv4((value >> 80n) & 0xffffffffn);
  }
  if (((value >> 32n) & 0xffffffffn) === 0x00005efen) {
    return publicIpv4(embeddedV4);
  }
  return true;
}

async function defaultPut(input: {
  url: URL;
  address: ResolvedAddress;
  contentType: string;
  bytes: Uint8Array;
}) {
  return await new Promise<number>((resolve, reject) => {
    const req = httpsRequest(
      input.url,
      {
        method: "PUT",
        headers: {
          "content-type": input.contentType,
          "content-length": input.bytes.byteLength,
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address.address, input.address.family),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.setTimeout(30_000, () =>
      req.destroy(new Error("Media upload timed out.")),
    );
    req.once("error", reject);
    req.end(input.bytes);
  });
}

export async function uploadPresignedMedia(
  file: File,
  uploadUrl: string,
  dependencies: MediaUploadDependencies = {},
) {
  const url = new URL(uploadUrl);
  if (url.protocol !== "https:") throw new Error("Unsafe media upload URL.");
  const resolveHost =
    dependencies.resolve ??
    (async (hostname) =>
      (await lookup(hostname, {
        all: true,
        verbatim: true,
      })) as ResolvedAddress[]);
  const addresses = await resolveHost(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !publicAddress(address))
  ) {
    throw new Error("Unsafe media upload address.");
  }
  const status = await (dependencies.put ?? defaultPut)({
    url,
    address: addresses[0] as ResolvedAddress,
    contentType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  // Redirects are deliberately refused; the validated address is the only network target.
  if (status < 200 || status >= 300)
    throw new Error(`Typefully media upload failed (${status}).`);
}
